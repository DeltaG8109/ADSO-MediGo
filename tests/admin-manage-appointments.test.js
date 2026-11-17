const path = require("node:path");
const pug = require("pug");
const { changeAppointment } = require("../src/modules/admin/services/manage-appointment");
const { createAdminRouter } = require("../src/modules/admin/routes");

const now = new Date("2026-11-16T12:00:00.000Z");

function harness() {
  const appointment = {
    id: 31, patientId: 81, doctorId: 9, specialtyId: 3, status: "CONFIRMED",
    startsAt: new Date("2026-11-18T14:00:00.000Z"),
    endsAt: new Date("2026-11-18T14:30:00.000Z"),
    patient: { user: { firstName: "Laura", lastName: "Paz", email: "laura@example.com" } },
    doctor: { user: { firstName: "Carlos", lastName: "Méndez" } },
    specialty: { name: "Medicina general" },
    update: jest.fn()
  };
  const models = {
    Appointment: {
      findByPk: jest.fn().mockResolvedValue(appointment),
      findAll: jest.fn().mockResolvedValue([])
    },
    Doctor: {
      findByPk: jest.fn().mockResolvedValue({
        id: 9, specialtyId: 3,
        user: { role: "DOCTOR", status: "ACTIVE" },
        specialty: { status: "ACTIVE", name: "Medicina general" }
      })
    },
    DoctorWeeklySchedule: {
      findAll: jest.fn().mockResolvedValue([{
        effectiveFrom: "2026-11-01", effectiveTo: null,
        blocks: [{ weekday: 3, startsAt: "09:00:00", endsAt: "11:00:00" }]
      }])
    },
    DoctorWeeklyScheduleBlock: {},
    DoctorScheduleException: { findAll: jest.fn().mockResolvedValue([]) },
    Patient: {}, User: { findByPk: jest.fn().mockResolvedValue({}) },
    Specialty: {}, AuditLog: { create: jest.fn().mockResolvedValue({}) }
  };
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const sequelize = { transaction: jest.fn((callback) => callback(transaction)) };
  return { appointment, models, sequelize, transaction };
}

describe("administrator appointment changes", () => {
  test("compiles the appointment management screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/admin/views/manage-appointment.pug"))).not.toThrow();
  });

  test("cancels a confirmed appointment and records the administrator and reason", async () => {
    const { appointment, models, sequelize, transaction } = harness();
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const result = await changeAppointment({
      sequelize, models, actorUserId: 5, appointmentId: "31", action: "cancel",
      reason: "El paciente lo solicitó", emailSender: { sendAppointmentCancellationNotification: sendEmail }, now
    });
    expect(result).toMatchObject({ status: "cancelled", notificationStatus: "sent" });
    expect(appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "CANCELLED", cancellationReason: "El paciente lo solicitó"
    }), { transaction });
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 5, action: "ADMIN_APPOINTMENT_CANCELLED", entityId: 31
    }), { transaction });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "laura@example.com" }));
  });

  test("reprograms with the same doctor and keeps the original appointment if the slot is busy", async () => {
    const busy = harness();
    busy.models.Appointment.findAll.mockResolvedValue([{
      startsAt: new Date("2026-11-18T15:00:00.000Z"),
      endsAt: new Date("2026-11-18T15:30:00.000Z")
    }]);
    const rejected = await changeAppointment({
      ...busy, actorUserId: 5, appointmentId: "31", action: "reschedule",
      reason: "Cambio solicitado", date: "2026-11-18", time: "10:00", now
    });
    expect(rejected.status).toBe("slot_unavailable");
    expect(busy.appointment.update).not.toHaveBeenCalled();

    const available = harness();
    const result = await changeAppointment({
      ...available, actorUserId: 5, appointmentId: "31", action: "reschedule",
      reason: "Cambio solicitado", date: "2026-11-18", time: "10:00", now
    });
    expect(result).toMatchObject({ status: "rescheduled", notificationStatus: "not_configured" });
    expect(available.models.Doctor.findByPk).toHaveBeenCalledWith(9, {
      transaction: available.transaction, lock: "UPDATE"
    });
    expect(available.appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      startsAt: new Date("2026-11-18T15:00:00.000Z"),
      endsAt: new Date("2026-11-18T15:30:00.000Z")
    }), { transaction: available.transaction });
    expect(available.models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 5, action: "ADMIN_APPOINTMENT_RESCHEDULED",
      afterData: expect.objectContaining({ reason: "Cambio solicitado" })
    }), { transaction: available.transaction });
  });

  test("requires an administrator for confirmation routes", () => {
    const router = createAdminRouter({ models: { User: { findByPk: jest.fn() } } });
    const route = router.stack.find((layer) => layer.route?.path === "/administrador/citas/:appointmentId/cancelar/confirmar");
    expect(route).toBeDefined();
    const requireAdminRole = route.route.stack[1].handle;
    const response = { status: jest.fn().mockReturnThis(), send: jest.fn() };
    requireAdminRole({ currentUser: { role: "DOCTOR" } }, response, () => {
      throw new Error("Un médico no debe continuar.");
    });
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
