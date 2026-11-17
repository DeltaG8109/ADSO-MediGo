const {
  appendConsultationAddendum,
  saveConsultationNotes
} = require("../src/modules/doctor/services/consultation-notes");

function setup({ appointmentStatus = "IN_PROGRESS", consultationStatus = "IN_PROGRESS", doctor = { id: 7 } } = {}) {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const consultation = {
    id: 12,
    status: consultationStatus,
    update: jest.fn().mockResolvedValue(undefined)
  };
  const models = {
    Doctor: { findOne: jest.fn().mockResolvedValue(doctor) },
    Appointment: {
      findOne: jest.fn().mockResolvedValue(doctor ? { id: 21, doctorId: 7, status: appointmentStatus } : null)
    },
    Consultation: { update: jest.fn(), findOne: jest.fn().mockResolvedValue(doctor ? consultation : null) },
    ConsultationAddendum: { create: jest.fn().mockResolvedValue({ id: 1 }) }
  };
  const sequelize = {
    transaction: jest.fn(async (callback) => callback(transaction))
  };
  return { sequelize, models, consultation };
}

describe("observaciones de consulta", () => {
  test("guarda texto opcional y permite dejarlo vacío", async () => {
    const { sequelize, models, consultation } = setup();
    const result = await saveConsultationNotes({
      sequelize, models, userId: 5, appointmentId: "21", notes: "   "
    });
    expect(result.status).toBe("saved");
    expect(consultation.update).toHaveBeenCalledWith(
      expect.objectContaining({ notes: null }),
      expect.objectContaining({ transaction: expect.any(Object) })
    );
  });

  test("rechaza observaciones que superan el límite", async () => {
    const { sequelize, models } = setup();
    const result = await saveConsultationNotes({
      sequelize, models, userId: 5, appointmentId: "21", notes: "a".repeat(10001)
    });
    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test("no permite cambiar el original después de completar", async () => {
    const { sequelize, models, consultation } = setup({
      appointmentStatus: "ATTENDED", consultationStatus: "COMPLETED"
    });
    const result = await saveConsultationNotes({
      sequelize, models, userId: 5, appointmentId: "21", notes: "Cambio"
    });
    expect(result.status).toBe("immutable");
    expect(consultation.update).not.toHaveBeenCalled();
  });

  test("no permite escribir a un usuario que no tiene perfil médico", async () => {
    const { sequelize, models } = setup({ doctor: null });
    const result = await saveConsultationNotes({
      sequelize, models, userId: 99, appointmentId: "21", notes: "Texto"
    });
    expect(result.status).toBe("not_found");
    expect(models.Appointment.findOne).not.toHaveBeenCalled();
  });
});

describe("aclaraciones de consulta", () => {
  test("agrega una aclaración nueva con autor y fecha", async () => {
    const { sequelize, models } = setup({
      appointmentStatus: "ATTENDED", consultationStatus: "COMPLETED"
    });
    const now = new Date("2026-11-17T15:00:00.000Z");
    const result = await appendConsultationAddendum({
      sequelize, models, userId: 5, appointmentId: "21", content: "  Aclaración  ", now
    });
    expect(result.status).toBe("added");
    expect(models.ConsultationAddendum.create).toHaveBeenCalledWith({
      consultationId: 12, doctorId: 7, content: "Aclaración", createdAt: now
    }, expect.objectContaining({ transaction: expect.any(Object) }));
  });

  test("rechaza aclaraciones antes de finalizar sin crear registros", async () => {
    const { sequelize, models } = setup();
    const result = await appendConsultationAddendum({
      sequelize, models, userId: 5, appointmentId: "21", content: "Aclaración"
    });
    expect(result.status).toBe("not_completed");
    expect(models.ConsultationAddendum.create).not.toHaveBeenCalled();
  });

  test("requiere contenido para una aclaración", async () => {
    const { sequelize, models } = setup({
      appointmentStatus: "ATTENDED", consultationStatus: "COMPLETED"
    });
    const result = await appendConsultationAddendum({
      sequelize, models, userId: 5, appointmentId: "21", content: "   "
    });
    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });
});
