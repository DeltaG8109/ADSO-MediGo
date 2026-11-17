const { finishDoctorConsultation } = require("../src/modules/doctor/services/finish-consultation");

function setup({ appointmentStatus = "IN_PROGRESS", consultationStatus = "IN_PROGRESS", doctor = { id: 7 } } = {}) {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const appointment = {
    id: 21, doctorId: 7, status: appointmentStatus,
    update: jest.fn().mockResolvedValue(undefined)
  };
  const consultation = {
    id: 12, status: consultationStatus, notes: null,
    update: jest.fn().mockResolvedValue(undefined)
  };
  const models = {
    Doctor: { findOne: jest.fn().mockResolvedValue(doctor) },
    Appointment: { findOne: jest.fn().mockResolvedValue(doctor ? appointment : null) },
    Consultation: { findOne: jest.fn().mockResolvedValue(doctor ? consultation : null) }
  };
  const sequelize = { transaction: jest.fn(async (callback) => callback(transaction)) };
  return { sequelize, models, appointment, consultation };
}

describe("finalizar consulta", () => {
  test("finaliza la cita y la consulta en la misma transacción aunque no haya observaciones", async () => {
    const { sequelize, models, appointment, consultation } = setup();
    const now = new Date("2026-11-17T16:00:00.000Z");
    const result = await finishDoctorConsultation({
      sequelize, models, userId: 5, appointmentId: "21", now
    });
    expect(result).toEqual({ status: "finished", appointmentId: 21, completedAt: now });
    expect(appointment.update).toHaveBeenCalledWith(
      { status: "ATTENDED", updatedAt: now }, expect.objectContaining({ transaction: expect.any(Object) })
    );
    expect(consultation.update).toHaveBeenCalledWith(
      { status: "COMPLETED", completedAt: now, updatedAt: now },
      expect.objectContaining({ transaction: expect.any(Object) })
    );
  });

  test("rechaza un identificador de cita inválido", async () => {
    const { sequelize, models } = setup();
    const result = await finishDoctorConsultation({
      sequelize, models, userId: 5, appointmentId: "abc"
    });
    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test("limita la finalización al médico asignado", async () => {
    const { sequelize, models } = setup({ doctor: null });
    const result = await finishDoctorConsultation({
      sequelize, models, userId: 99, appointmentId: "21"
    });
    expect(result.status).toBe("not_found");
    expect(models.Appointment.findOne).not.toHaveBeenCalled();
  });

  test("no permite finalizar dos veces", async () => {
    const { sequelize, models, appointment, consultation } = setup({
      appointmentStatus: "ATTENDED", consultationStatus: "COMPLETED"
    });
    const result = await finishDoctorConsultation({
      sequelize, models, userId: 5, appointmentId: "21"
    });
    expect(result.status).toBe("already_completed");
    expect(appointment.update).not.toHaveBeenCalled();
    expect(consultation.update).not.toHaveBeenCalled();
  });

  test("no cambia estados inconsistentes", async () => {
    const { sequelize, models, appointment, consultation } = setup({
      appointmentStatus: "IN_PROGRESS", consultationStatus: "COMPLETED"
    });
    const result = await finishDoctorConsultation({
      sequelize, models, userId: 5, appointmentId: "21"
    });
    expect(result.status).toBe("invalid_state");
    expect(appointment.update).not.toHaveBeenCalled();
    expect(consultation.update).not.toHaveBeenCalled();
  });
});
