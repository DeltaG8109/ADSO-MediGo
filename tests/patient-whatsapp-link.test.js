const crypto = require("node:crypto");
const {
  getPatientWhatsAppLink,
  normalizeWhatsAppPhone,
  requestPatientWhatsAppVerification,
  unlinkPatientWhatsApp,
  verifyPatientWhatsAppCode
} = require("../src/modules/patient/services/whatsapp-link");

const SECRET = "test-secret-for-whatsapp";
const NOW = new Date("2026-11-17T16:00:00.000Z");

function setup(patientOverrides = {}) {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const patient = {
    id: 13, userId: 5, whatsappPhone: null, whatsappConsentAt: null,
    whatsappVerifiedAt: null, whatsappVerificationCodeHash: null,
    whatsappVerificationExpiresAt: null, whatsappVerificationAttempts: 0,
    update: jest.fn().mockResolvedValue(undefined),
    ...patientOverrides
  };
  const models = {
    Patient: {
      findOne: jest.fn(async ({ where }) => where.userId === undefined ? null : patient),
      update: jest.fn().mockResolvedValue([1])
    }
  };
  const sequelize = { transaction: jest.fn(async (callback) => callback(transaction)) };
  return { sequelize, models, patient };
}

describe("vinculación de WhatsApp", () => {
  test("normaliza y valida números internacionales", () => {
    expect(normalizeWhatsAppPhone(" +57 (300) 123-4567 ")).toBe("+573001234567");
    expect(normalizeWhatsAppPhone("3001234567")).toBeNull();
  });

  test("requiere consentimiento explícito", async () => {
    const { sequelize, models } = setup();
    const result = await requestPatientWhatsAppVerification({
      sequelize, models, userId: 5, phone: "+573001234567", consent: false,
      secret: SECRET, now: NOW
    });
    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test("envía un código de seis dígitos y guarda solo su hash", async () => {
    const { sequelize, models, patient } = setup();
    models.Patient.findOne
      .mockResolvedValueOnce(patient)
      .mockResolvedValueOnce(null);
    const sender = { sendVerificationCode: jest.fn().mockResolvedValue({ status: "sent" }) };
    const result = await requestPatientWhatsAppVerification({
      sequelize, models, userId: 5, phone: "+573001234567", consent: true, sender,
      secret: SECRET, now: NOW, randomInt: () => 123456
    });
    expect(result.status).toBe("code_sent");
    expect(sender.sendVerificationCode).toHaveBeenCalledWith({ to: "+573001234567", code: "123456" });
    expect(patient.update).toHaveBeenCalledWith(expect.objectContaining({
      whatsappPhone: "+573001234567", whatsappConsentAt: NOW,
      whatsappVerificationExpiresAt: new Date(NOW.getTime() + 5 * 60 * 1000),
      whatsappVerificationAttempts: 0
    }), expect.any(Object));
    const saved = patient.update.mock.calls[0][0];
    expect(saved.whatsappVerificationCodeHash).not.toBe("123456");
    expect(saved.whatsappVerificationCodeHash).toHaveLength(64);
  });

  test("no permite usar el mismo número en otro perfil", async () => {
    const { sequelize, models, patient } = setup();
    models.Patient.findOne
      .mockResolvedValueOnce(patient)
      .mockResolvedValueOnce({ id: 99 });
    const sender = { sendVerificationCode: jest.fn() };
    const result = await requestPatientWhatsAppVerification({
      sequelize, models, userId: 5, phone: "+573001234567", consent: true,
      sender, secret: SECRET, now: NOW
    });
    expect(result.status).toBe("already_used");
    expect(sender.sendVerificationCode).not.toHaveBeenCalled();
  });

  test("verifica el código y confirma el número", async () => {
    const digest = crypto.createHmac("sha256", SECRET).update("123456").digest("hex");
    const { sequelize, models, patient } = setup({
      whatsappPhone: "+573001234567",
      whatsappVerificationCodeHash: digest,
      whatsappVerificationExpiresAt: new Date(NOW.getTime() + 1000)
    });
    const result = await verifyPatientWhatsAppCode({
      sequelize, models, userId: 5, code: "123456", secret: SECRET, now: NOW
    });
    expect(result).toEqual({ status: "verified", phone: "+573001234567" });
    expect(patient.update).toHaveBeenCalledWith(expect.objectContaining({
      whatsappVerifiedAt: NOW, whatsappVerificationCodeHash: null,
      whatsappVerificationExpiresAt: null, whatsappVerificationAttempts: 0
    }), expect.any(Object));
  });

  test("cuenta los intentos fallidos y bloquea el quinto", async () => {
    const digest = crypto.createHmac("sha256", SECRET).update("123456").digest("hex");
    const { sequelize, models, patient } = setup({
      whatsappPhone: "+573001234567",
      whatsappVerificationCodeHash: digest,
      whatsappVerificationExpiresAt: new Date(NOW.getTime() + 1000),
      whatsappVerificationAttempts: 4
    });
    const result = await verifyPatientWhatsAppCode({
      sequelize, models, userId: 5, code: "654321", secret: SECRET, now: NOW
    });
    expect(result.status).toBe("attempts_exhausted");
    expect(patient.update).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappVerificationAttempts: 5 }),
      expect.any(Object)
    );
  });

  test("rechaza un código vencido", async () => {
    const { sequelize, models, patient } = setup({
      whatsappPhone: "+573001234567",
      whatsappVerificationCodeHash: "a".repeat(64),
      whatsappVerificationExpiresAt: new Date(NOW.getTime() - 1)
    });
    const result = await verifyPatientWhatsAppCode({
      sequelize, models, userId: 5, code: "123456", secret: SECRET, now: NOW
    });
    expect(result.status).toBe("expired");
    expect(patient.update).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappVerificationCodeHash: null }),
      expect.any(Object)
    );
  });

  test("desvincula el número solo al ejecutar la confirmación", async () => {
    const { sequelize, models, patient } = setup({
      whatsappPhone: "+573001234567", whatsappVerifiedAt: NOW
    });
    const result = await unlinkPatientWhatsApp({ sequelize, models, userId: 5, now: NOW });
    expect(result.status).toBe("unlinked");
    expect(patient.update).toHaveBeenCalledWith(expect.objectContaining({
      whatsappPhone: null, whatsappVerifiedAt: null, whatsappConsentAt: null
    }), expect.any(Object));
  });

  test("muestra el estado sin exponer el hash del código", async () => {
    const { models } = setup({
      whatsappPhone: "+573001234567", whatsappVerificationCodeHash: "b".repeat(64),
      whatsappVerificationExpiresAt: new Date(NOW.getTime() + 1000)
    });
    const result = await getPatientWhatsAppLink({ models, userId: 5 });
    expect(result.status).toBe("ready");
    expect(result.pending).toBe(true);
    expect(JSON.stringify(result)).not.toContain("b".repeat(64));
  });
});
