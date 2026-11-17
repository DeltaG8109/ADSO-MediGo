const path = require("node:path");
const pug = require("pug");
const { startDoctorConsultation } = require("../src/modules/doctor/services/start-consultation");
const { createDoctorRouter } = require("../src/modules/doctor/routes");

const now = new Date("2026-11-18T14:15:00.000Z");

function harness({ status = "CONFIRMED", appointment = null, existing = null } = {}) {
  const appointmentRecord = appointment || {
    id: 31, doctorId: 9, status,
    startsAt: new Date("2026-11-18T14:00:00.000Z"),
    endsAt: new Date("2026-11-18T14:30:00.000Z"),
    update: jest.fn().mockResolvedValue(undefined)
  };
  const consultation = { startedAt: now };
  const models = {
    Doctor: { findOne: jest.fn().mockResolvedValue({ id: 9 }) },
    Appointment: { findOne: jest.fn().mockResolvedValue(appointmentRecord) },
    Consultation: {
      findOne: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockResolvedValue(consultation)
    }
  };
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const sequelize = { transaction: jest.fn((callback) => callback(transaction)) };
  return { models, appointmentRecord, consultation, sequelize, transaction };
}

describe("doctor consultation start", () => {
  test("compiles the appointment detail screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/doctor/views/appointment-detail.pug"))).not.toThrow();
  });

  test("starts the assigned confirmed appointment during its scheduled block", async () => {
    const { models, appointmentRecord, sequelize, transaction } = harness();
    const result = await startDoctorConsultation({
      sequelize, models, userId: 44, appointmentId: "31", now
    });
    expect(result).toMatchObject({ status: "started", appointmentId: 31, startedAt: now });
    expect(models.Appointment.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "31", doctorId: 9 }, transaction, lock: "UPDATE"
    }));
    expect(appointmentRecord.update).toHaveBeenCalledWith({
      status: "IN_PROGRESS", updatedAt: now
    }, { transaction });
    expect(models.Consultation.create).toHaveBeenCalledWith(expect.objectContaining({
      appointmentId: 31, doctorId: 9, status: "IN_PROGRESS",
      notes: null, startedAt: now, completedAt: null
    }), { transaction });
  });

  test("rejects a different doctor's appointment and an appointment outside its time block", async () => {
    const unrelated = harness();
    unrelated.models.Appointment.findOne.mockResolvedValue(null);
    expect((await startDoctorConsultation({
      sequelize: unrelated.sequelize, models: unrelated.models, userId: 44, appointmentId: "31", now
    })).status).toBe("not_found");
    expect(unrelated.models.Consultation.create).not.toHaveBeenCalled();

    const tooEarly = harness();
    expect((await startDoctorConsultation({
      sequelize: tooEarly.sequelize, models: tooEarly.models, userId: 44, appointmentId: "31",
      now: new Date("2026-11-18T13:59:59.999Z")
    })).status).toBe("outside_window");
    expect(tooEarly.appointmentRecord.update).not.toHaveBeenCalled();
  });

  test("does not start a non-confirmed or previously started appointment", async () => {
    const inProgress = harness({ status: "IN_PROGRESS" });
    expect((await startDoctorConsultation({
      sequelize: inProgress.sequelize, models: inProgress.models, userId: 44, appointmentId: "31", now
    })).status).toBe("invalid_state");
    expect(inProgress.models.Consultation.create).not.toHaveBeenCalled();

    const repeated = harness({ existing: { id: 81 } });
    expect((await startDoctorConsultation({
      sequelize: repeated.sequelize, models: repeated.models, userId: 44, appointmentId: "31", now
    })).status).toBe("already_started");
    expect(repeated.appointmentRecord.update).not.toHaveBeenCalled();
  });

  test("requires a doctor for the start route", () => {
    const router = createDoctorRouter({ models: { User: { findByPk: jest.fn() } } });
    const route = router.stack.find((layer) => layer.route?.path === "/medico/consultas/iniciar/:appointmentId");
    expect(route).toBeDefined();
    const requireDoctorRole = route.route.stack[1].handle;
    const response = { status: jest.fn().mockReturnThis(), render: jest.fn() };
    requireDoctorRole({ currentUser: { role: "PATIENT" } }, response, () => {
      throw new Error("Un paciente no debe continuar.");
    });
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
