const path = require("node:path");
const pug = require("pug");
const { Op } = require("sequelize");
const {
  createAdminAppointment,
  getAdminAppointmentBookingPage
} = require("../src/modules/admin/services/create-appointment");
const { createAdminRouter } = require("../src/modules/admin/routes");

const now = new Date("2026-11-16T12:00:00.000Z");
const doctor = {
  id: 9, specialtyId: 3,
  user: { role: "DOCTOR", status: "ACTIVE", firstName: "Carlos", lastName: "Méndez" },
  specialty: { id: 3, name: "Medicina general", status: "ACTIVE" }
};

function modelsFor({ upcoming = null, slots = [] } = {}) {
  const appointment = { id: 31 };
  return {
    Patient: {
      findAll: jest.fn().mockResolvedValue([{ id: 81, userId: 22, user: {
        firstName: "Laura", lastName: "Paz", documentType: "CC", documentNumber: "456"
      } }]),
      findByPk: jest.fn().mockResolvedValue({ id: 81, userId: 22 })
    },
    User: { findByPk: jest.fn().mockResolvedValue({
      id: 22, role: "PATIENT", status: "ACTIVE", emailVerifiedAt: now,
      firstName: "Laura", lastName: "Paz", email: "laura@example.com"
    }) },
    Specialty: { findAll: jest.fn().mockResolvedValue([{ id: 3, name: "Medicina general" }]) },
    Doctor: { findByPk: jest.fn().mockResolvedValue(doctor), findAll: jest.fn().mockResolvedValue([doctor]) },
    DoctorWeeklySchedule: {
      findAll: jest.fn().mockResolvedValue([{
        effectiveFrom: "2026-11-01", effectiveTo: null,
        blocks: [{ weekday: 2, startsAt: "09:00:00", endsAt: "10:00:00" }]
      }])
    },
    DoctorWeeklyScheduleBlock: {},
    DoctorScheduleException: { findAll: jest.fn().mockResolvedValue([]) },
    Appointment: {
      findOne: jest.fn().mockResolvedValue(upcoming),
      findAll: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(appointment)
    },
    AuditLog: { create: jest.fn().mockResolvedValue({}) },
    appointment
  };
}

function transactionHarness() {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  return { transaction, sequelize: { transaction: jest.fn((callback) => callback(transaction)) } };
}

describe("administrator appointment creation", () => {
  test("compiles the creation screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/admin/views/create-appointment.pug"))).not.toThrow();
  });

  test("shows eligible patients and available slots from the selected doctor", async () => {
    const models = modelsFor();
    const page = await getAdminAppointmentBookingPage({
      models, query: { patientId: "81", specialtyId: "3", doctorId: "9", date: "2026-11-17" }, now
    });
    expect(page.status).toBe("ready");
    expect(page.selectedPatient.name).toBe("Laura Paz");
    expect(page.selectedDoctor.name).toBe("Carlos Méndez");
    expect(page.slots.map((slot) => slot.time)).toEqual(["09:00", "09:30"]);
  });

  test("creates the appointment with the administrator as creator and records the actor", async () => {
    const models = modelsFor();
    const { sequelize, transaction } = transactionHarness();
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const result = await createAdminAppointment({
      sequelize, models, actorUserId: 5, patientId: "81", specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:30", emailSender: { sendAppointmentBookingNotification: sendEmail }, now
    });
    expect(result).toMatchObject({ status: "booked", notificationStatus: "sent", appointmentId: 31 });
    expect(models.Appointment.create).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 81, doctorId: 9, specialtyId: 3,
      startsAt: new Date("2026-11-17T14:30:00.000Z"),
      endsAt: new Date("2026-11-17T15:00:00.000Z"),
      createdByUserId: 5, status: "CONFIRMED"
    }), { transaction });
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 5, action: "ADMIN_APPOINTMENT_BOOKED", entityId: 31
    }), { transaction });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "laura@example.com" }));
  });

  test("does not create a duplicate when the patient already has a future confirmed appointment", async () => {
    const models = modelsFor({ upcoming: { id: 88 } });
    const { sequelize } = transactionHarness();
    const result = await createAdminAppointment({
      sequelize, models, actorUserId: 5, patientId: "81", specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:30", now
    });
    expect(result.status).toBe("patient_has_upcoming");
    expect(models.Appointment.create).not.toHaveBeenCalled();
  });

  test("revalidates a busy slot and preserves the appointment list", async () => {
    const models = modelsFor();
    models.Appointment.findAll.mockResolvedValue([{
      startsAt: new Date("2026-11-17T14:30:00.000Z"),
      endsAt: new Date("2026-11-17T15:00:00.000Z")
    }]);
    const { sequelize } = transactionHarness();
    const result = await createAdminAppointment({
      sequelize, models, actorUserId: 5, patientId: "81", specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:30", now
    });
    expect(result.status).toBe("slot_unavailable");
    expect(models.Appointment.create).not.toHaveBeenCalled();
  });

  test("rejects an invalid time before starting the transaction", async () => {
    const models = modelsFor();
    const { sequelize } = transactionHarness();
    const result = await createAdminAppointment({
      sequelize, models, actorUserId: 5, patientId: "81", specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "25:99", now
    });
    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test("keeps the appointment saved when the email cannot be sent", async () => {
    const models = modelsFor();
    const { sequelize } = transactionHarness();
    const result = await createAdminAppointment({
      sequelize, models, actorUserId: 5, patientId: "81", specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:30",
      emailSender: { sendAppointmentBookingNotification: jest.fn().mockRejectedValue(new Error("SMTP down")) },
      now
    });
    expect(result).toMatchObject({ status: "booked", notificationStatus: "failed" });
    expect(models.Appointment.create).toHaveBeenCalled();
    expect(models.AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "ADMIN_APPOINTMENT_BOOKING_EMAIL_FAILED",
      afterData: { status: "failed" }
    }));
  });
});


describe("administrator appointment creation access", () => {
  test("requires an administrator to confirm an appointment", () => {
    const router = createAdminRouter({ models: { User: { findByPk: jest.fn() } } });
    const route = router.stack.find((layer) => layer.route?.path === "/administrador/citas/nueva/confirmar");
    expect(route).toBeDefined();
    const requireAdminRole = route.route.stack[1].handle;
    const response = { status: jest.fn().mockReturnThis(), render: jest.fn() };
    requireAdminRole({ currentUser: { role: "DOCTOR" } }, response, () => {
      throw new Error("Un médico no debe continuar.");
    });
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
