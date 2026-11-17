const MAX_NOTES_LENGTH = 10000;
const MAX_ADDENDUM_LENGTH = 10000;

function inputText(value, maxLength, required = false) {
  if (typeof value !== "string") return { valid: false, value: "" };
  const normalized = value.trim();
  return {
    valid: normalized.length <= maxLength && (!required || normalized.length > 0),
    value: normalized
  };
}

async function withAuthorizedConsultation({ sequelize, models, userId, appointmentId, action }) {
  if (!/^[1-9]\\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
  if (!sequelize?.transaction || !models?.Doctor?.findOne || !models?.Appointment?.findOne
    || !models?.Consultation?.findOne) return { status: "unavailable" };

  try {
    return await sequelize.transaction(async (transaction) => {
      const doctor = await models.Doctor.findOne({
        where: { userId }, attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE
      });
      if (!doctor) return { status: "not_found" };

      const appointment = await models.Appointment.findOne({
        where: { id: appointmentId, doctorId: doctor.id },
        attributes: ["id", "doctorId", "status"],
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!appointment) return { status: "not_found" };

      const consultation = await models.Consultation.findOne({
        where: { appointmentId: appointment.id, doctorId: doctor.id },
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!consultation) return { status: "not_found" };
      return action({ transaction, doctor, appointment, consultation });
    });
  } catch {
    return { status: "error" };
  }
}

async function saveConsultationNotes({ sequelize, models, userId, appointmentId, notes }) {
  const input = inputText(notes, MAX_NOTES_LENGTH);
  if (!input.valid) return { status: "invalid" };
  if (!models?.Consultation?.update) return { status: "unavailable" };
  return withAuthorizedConsultation({
    sequelize, models, userId, appointmentId,
    action: async ({ transaction, appointment, consultation }) => {
      if (appointment.status !== "IN_PROGRESS" || consultation.status !== "IN_PROGRESS") {
        return { status: "immutable" };
      }
      await consultation.update({ notes: input.value || null, updatedAt: new Date() }, { transaction });
      return { status: "saved" };
    }
  });
}

async function appendConsultationAddendum({ sequelize, models, userId, appointmentId, content, now = new Date() }) {
  const input = inputText(content, MAX_ADDENDUM_LENGTH, true);
  if (!input.valid) return { status: "invalid" };
  if (!models?.ConsultationAddendum?.create) return { status: "unavailable" };
  return withAuthorizedConsultation({
    sequelize, models, userId, appointmentId,
    action: async ({ transaction, doctor, appointment, consultation }) => {
      if (appointment.status !== "ATTENDED" || consultation.status !== "COMPLETED") {
        return { status: "not_completed" };
      }
      await models.ConsultationAddendum.create({
        consultationId: consultation.id,
        doctorId: doctor.id,
        content: input.value,
        createdAt: now
      }, { transaction });
      return { status: "added" };
    }
  });
}

module.exports = {
  MAX_ADDENDUM_LENGTH,
  MAX_NOTES_LENGTH,
  appendConsultationAddendum,
  saveConsultationNotes
};
