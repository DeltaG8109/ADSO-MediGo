const crypto = require("node:crypto");
const { Op } = require("sequelize");

const CODE_LENGTH = 6;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;

function normalizeWhatsAppPhone(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[\\s().-]/g, "");
  return /^\\+[1-9]\\d{7,14}$/.test(normalized) ? normalized : null;
}

function codeDigest(code, secret) {
  if (!secret) return null;
  return crypto.createHmac("sha256", secret).update(code).digest("hex");
}

function secureEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
  return crypto.timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
}

async function getPatientWhatsAppLink({ models, userId }) {
  if (!models?.Patient?.findOne) return { status: "unavailable" };
  try {
    const patient = await models.Patient.findOne({
      where: { userId },
      attributes: ["whatsappPhone", "whatsappConsentAt", "whatsappVerifiedAt", "whatsappVerificationExpiresAt", "whatsappVerificationAttempts"]
    });
    if (!patient) return { status: "not_found" };
    const linked = Boolean(patient.whatsappPhone && patient.whatsappVerifiedAt);
    const pending = Boolean(patient.whatsappPhone && patient.whatsappVerificationCodeHash !== null
      && patient.whatsappVerificationExpiresAt);
    return {
      status: "ready",
      linked,
      pending,
      phone: patient.whatsappPhone || null,
      consentAt: patient.whatsappConsentAt || null,
      expiresAt: patient.whatsappVerificationExpiresAt || null,
      attemptsRemaining: Math.max(0, MAX_CODE_ATTEMPTS - Number(patient.whatsappVerificationAttempts || 0))
    };
  } catch {
    return { status: "error" };
  }
}

async function requestPatientWhatsAppVerification({
  sequelize, models, userId, phone, consent, sender, secret = process.env.WHATSAPP_VERIFICATION_SECRET,
  now = new Date(), randomInt = crypto.randomInt
}) {
  const normalizedPhone = normalizeWhatsAppPhone(phone);
  if (!normalizedPhone || consent !== true) return { status: "invalid" };
  if (!secret) return { status: "unavailable" };
  if (!sequelize?.transaction || !models?.Patient?.findOne || !models?.Patient?.update) {
    return { status: "unavailable" };
  }
  const code = String(randomInt(100000, 1000000));
  const digest = codeDigest(code, secret);
  if (!digest) return { status: "unavailable" };

  try {
    const prepared = await sequelize.transaction(async (transaction) => {
      const patient = await models.Patient.findOne({
        where: { userId }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (!patient) return { status: "not_found" };
      if (patient.whatsappVerifiedAt) {
        return patient.whatsappPhone === normalizedPhone ? { status: "already_linked" } : { status: "unlink_first" };
      }
      const used = await models.Patient.findOne({
        where: { whatsappPhone: normalizedPhone, id: { [Op.ne]: patient.id } },
        attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE
      });
      if (used) return { status: "already_used" };

      await patient.update({
        whatsappPhone: normalizedPhone,
        whatsappConsentAt: now,
        whatsappVerificationCodeHash: digest,
        whatsappVerificationExpiresAt: new Date(now.getTime() + CODE_TTL_MS),
        whatsappVerificationAttempts: 0,
        updatedAt: now
      }, { transaction });
      return { status: "prepared", patientId: patient.id };
    });

    if (prepared.status !== "prepared") return prepared;
    const delivery = await sender?.sendVerificationCode({ to: normalizedPhone, code });
    if (delivery?.status === "sent") {
      return { status: "code_sent", phone: normalizedPhone, expiresAt: new Date(now.getTime() + CODE_TTL_MS) };
    }
    await models.Patient.update({
      whatsappPhone: null,
      whatsappConsentAt: null,
      whatsappVerificationCodeHash: null,
      whatsappVerificationExpiresAt: null,
      whatsappVerificationAttempts: 0,
      updatedAt: now
    }, { where: { id: prepared.patientId, whatsappVerificationCodeHash: digest } });
    return { status: delivery?.status === "unavailable" ? "unavailable" : "delivery_failed" };
  } catch (error) {
    return error?.name === "SequelizeUniqueConstraintError"
      ? { status: "already_used" }
      : { status: "error" };
  }
}

async function verifyPatientWhatsAppCode({
  sequelize, models, userId, code, secret = process.env.WHATSAPP_VERIFICATION_SECRET, now = new Date()
}) {
  const normalizedCode = typeof code === "string" ? code.trim() : "";
  if (!/^\\d{6}$/.test(normalizedCode)) return { status: "invalid_format" };
  if (!secret) return { status: "unavailable" };
  if (!sequelize?.transaction || !models?.Patient?.findOne) return { status: "unavailable" };

  try {
    return await sequelize.transaction(async (transaction) => {
      const patient = await models.Patient.findOne({
        where: { userId }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (!patient?.whatsappPhone || !patient.whatsappVerificationCodeHash) return { status: "not_found" };
      const attempts = Number(patient.whatsappVerificationAttempts || 0);
      if (attempts >= MAX_CODE_ATTEMPTS) return { status: "attempts_exhausted" };
      const expiresAt = new Date(patient.whatsappVerificationExpiresAt);
      if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()) {
        await patient.update({
          whatsappVerificationCodeHash: null, whatsappVerificationExpiresAt: null, updatedAt: now
        }, { transaction });
        return { status: "expired" };
      }
      const expected = codeDigest(normalizedCode, secret);
      if (!secureEqualHex(expected, patient.whatsappVerificationCodeHash)) {
        const nextAttempts = attempts + 1;
        await patient.update({ whatsappVerificationAttempts: nextAttempts, updatedAt: now }, { transaction });
        return { status: nextAttempts >= MAX_CODE_ATTEMPTS ? "attempts_exhausted" : "invalid_code" };
      }
      await patient.update({
        whatsappVerifiedAt: now,
        whatsappVerificationCodeHash: null,
        whatsappVerificationExpiresAt: null,
        whatsappVerificationAttempts: 0,
        updatedAt: now
      }, { transaction });
      return { status: "verified", phone: patient.whatsappPhone };
    });
  } catch {
    return { status: "error" };
  }
}

async function unlinkPatientWhatsApp({ sequelize, models, userId, now = new Date() }) {
  if (!sequelize?.transaction || !models?.Patient?.findOne) return { status: "unavailable" };
  try {
    return await sequelize.transaction(async (transaction) => {
      const patient = await models.Patient.findOne({
        where: { userId }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (!patient) return { status: "not_found" };
      if (!patient.whatsappPhone) return { status: "not_linked" };
      await patient.update({
        whatsappPhone: null,
        whatsappConsentAt: null,
        whatsappVerifiedAt: null,
        whatsappVerificationCodeHash: null,
        whatsappVerificationExpiresAt: null,
        whatsappVerificationAttempts: 0,
        updatedAt: now
      }, { transaction });
      return { status: "unlinked" };
    });
  } catch {
    return { status: "error" };
  }
}

module.exports = {
  CODE_LENGTH,
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  getPatientWhatsAppLink,
  normalizeWhatsAppPhone,
  requestPatientWhatsAppVerification,
  unlinkPatientWhatsApp,
  verifyPatientWhatsAppCode
};
