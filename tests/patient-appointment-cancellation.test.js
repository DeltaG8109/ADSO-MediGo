const path = require("node:path");
const pug = require("pug");
const {
  cancelPatientAppointment,
  getPatientAppointmentCancellation
} = require("../src/modules/patient/services/cancel-appointment");

const now = new Date("2026-11-16T12:00:00.000Z");

function cancellationModels({ startsAt = new Date(now.getTime() + 30 * 60 * 60 * 1000), status = "CONFIRMED", record = null } = {}) {
  const appointment = record || {
    id: 31,
    patientId: 8,
    status,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60 * 1000),
    doctor: { user: { firstName: "Camila", lastName: "Rojas" } },
    specialty: { name: "Medicina general" },
    update: jest.fn(async function update(values) { Object.assign(this, values); })
  };
  return {
    Patient: { findOne: jest.fn().mockResolvedValue({ id: 8, userId: 22 }) },
    User: { findByPk: jest.fn().mockResolvedValue({ firstName: "Laura", email: "laura@example.com" }) },
    Doctor: {},
    Specialty: {},
    Appointment: { findOne: jest.fn().mockResolvedValue(appointment) },
    AuditLog: { create: jest.fn().mockResolvedValue({}) },
    appointment
  };
}

function transactionHarness() {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  return {
    transaction,
    sequelize: { transaction: jest.fn((callback) => callback(transaction)) }
  };
}

describe("patient appointment cancellation", () => {
  test("compiles the cancellation confirmation screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/patient/views/appointment-cancellation.pug"))).not.toThrow();
  });

  test("shows the confirmation details only for the signed-in patient's appointment", async () => {
    const models = cancellationModels();
    const result = await getPatientAppointmentCancellation({
      models, userId: 22, appointmentId: "31", now
    });

    expect(result.status).toBe("ready");
    expect(result.appointment).toMatchObject({
      doctorName: "Camila Rojas",
      specialtyName: "Medicina general",
      canCancel: true
    });
    expect(models.Patient.findOne).toHaveBeenCalledWith({ where: { userId: 22 } });
    expect(models.Appointment.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "31", patientId: 8 }
    }));
  });

  test("cancels a confirmed appointment at least 24 hours ahead and records its actor", async () => {
    const models = cancellationModels();
    const { sequelize, transaction } = transactionHarness();
    const sendEmail = jest.fn().mockResolvedValue(undefined);

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      emailSender: { sendAppointmentCancellationNotification: sendEmail }, now
    });

    expect(result).toMatchObject({ status: "cancelled", notificationStatus: "sent", appointmentId: 31 });
    expect(models.appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "CANCELLED",
      cancelledAt: now,
      cancellationReason: "Cancelada por el paciente"
    }), { transaction });
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 22,
      action: "PATIENT_APPOINTMENT_CANCELLED",
      entityId: 31,
      beforeData: expect.objectContaining({ status: "CONFIRMED" }),
      afterData: expect.objectContaining({ status: "CANCELLED" })
    }), { transaction });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "laura@example.com",
      appointmentDate: expect.any(String),
      appointmentTime: expect.any(String)
    }));
  });

  test("does not cancel an appointment inside the 24-hour window", async () => {
    const models = cancellationModels({ startsAt: new Date(now.getTime() + 23 * 60 * 60 * 1000) });
    const { sequelize } = transactionHarness();

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31", now
    });

    expect(result.status).toBe("not_cancellable");
    expect(models.appointment.update).not.toHaveBeenCalled();
    expect(models.AuditLog.create).not.toHaveBeenCalled();
  });

  test("does not cancel a visit that is not confirmed", async () => {
    const models = cancellationModels({ status: "IN_PROGRESS" });
    const { sequelize } = transactionHarness();

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31", now
    });

    expect(result.status).toBe("not_cancellable");
    expect(models.appointment.update).not.toHaveBeenCalled();
  });

  test("does not find appointments belonging to another patient", async () => {
    const models = cancellationModels();
    models.Appointment.findOne.mockResolvedValue(null);
    const { sequelize } = transactionHarness();

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 404, appointmentId: "31", now
    });

    expect(result.status).toBe("not_found");
    expect(models.Appointment.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "31", patientId: 8 }
    }));
    expect(models.appointment.update).not.toHaveBeenCalled();
  });

  test("keeps the cancellation when the email cannot be delivered", async () => {
    const models = cancellationModels();
    const { sequelize } = transactionHarness();

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      emailSender: { sendAppointmentCancellationNotification: jest.fn().mockRejectedValue(new Error("SMTP down")) },
      now
    });

    expect(result).toMatchObject({ status: "cancelled", notificationStatus: "failed" });
    expect(models.appointment.update).toHaveBeenCalled();
    expect(models.AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "PATIENT_APPOINTMENT_CANCELLATION_EMAIL_FAILED",
      afterData: { status: "failed" }
    }));
  });

  test("rejects malformed appointment identifiers before looking up a patient", async () => {
    const models = cancellationModels();
    const { sequelize } = transactionHarness();

    const result = await cancelPatientAppointment({
      sequelize, models, userId: 22, appointmentId: "abc", now
    });

    expect(result.status).toBe("invalid");
    expect(models.Patient.findOne).not.toHaveBeenCalled();
  });
});
