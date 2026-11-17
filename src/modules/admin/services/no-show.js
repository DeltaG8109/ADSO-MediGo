const TIME_ZONE = "America/Bogota";

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function displayAppointment(record) {
  const item = plain(record);
  const patient = plain(item.patient) || {};
  const patientUser = plain(patient.user) || {};
  const doctor = plain(item.doctor) || {};
  const doctorUser = plain(doctor.user) || {};
  const specialty = plain(item.specialty) || {};
  const startsAt = new Date(item.startsAt);
  const endsAt = new Date(item.endsAt);
  const formatDate = (date) => new Intl.DateTimeFormat("es-CO", {
    timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);
  const formatTime = (date) => new Intl.DateTimeFormat("es-CO", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true
  }).format(date);
  return {
    id: item.id, status: item.status, startsAt, endsAt,
    date: formatDate(startsAt), time: formatTime(startsAt), endTime: formatTime(endsAt),
    patientName: [patientUser.firstName, patientUser.lastName].filter(Boolean).join(" ") || "Paciente",
    doctorName: [doctorUser.firstName, doctorUser.lastName].filter(Boolean).join(" ") || "Médico asignado",
    specialtyName: specialty.name || "Especialidad asignada"
  };
}

function eligibility(item, now) {
  if (item.status !== "CONFIRMED") return { status: "not_confirmed" };
  const endsAt = new Date(item.endsAt);
  if (!Number.isFinite(endsAt.getTime())) return { status: "error" };
  if (endsAt.getTime() > now.getTime()) return { status: "not_finished" };
  return { status: "ready" };
}

function appointmentIncludes(models) {
  return [
    {
      model: models.Patient, as: "patient", required: false, attributes: ["id"],
      include: models.User ? [{ model: models.User, as: "user", required: false, attributes: ["firstName", "lastName"] }] : []
    },
    {
      model: models.Doctor, as: "doctor", required: false, attributes: ["id"],
      include: models.User ? [{ model: models.User, as: "user", required: false, attributes: ["firstName", "lastName"] }] : []
    },
    models.Specialty ? { model: models.Specialty, as: "specialty", required: false, attributes: ["name"] } : null
  ].filter(Boolean);
}

async function getNoShowPreview({ models, appointmentId, now = new Date() }) {
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
  if (!models?.Appointment?.findByPk) return { status: "unavailable" };
  try {
    const record = await models.Appointment.findByPk(appointmentId, {
      attributes: ["id", "startsAt", "endsAt", "status"],
      include: appointmentIncludes(models)
    });
    if (!record) return { status: "not_found" };
    const item = plain(record);
    const check = eligibility(item, now);
    return { ...check, appointment: displayAppointment(record) };
  } catch {
    return { status: "error" };
  }
}

async function markAppointmentNoShow({
  sequelize, models, actorUserId, appointmentId, confirmed, now = new Date()
}) {
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
  if (confirmed !== "YES") return { status: "confirmation_required" };
  if (!sequelize?.transaction || !models?.Appointment?.findByPk || !models?.AuditLog?.create) {
    return { status: "unavailable" };
  }
  try {
    return await sequelize.transaction(async (transaction) => {
      const record = await models.Appointment.findByPk(appointmentId, {
        transaction, lock: transaction.LOCK.UPDATE,
        attributes: ["id", "startsAt", "endsAt", "status"],
        include: appointmentIncludes(models)
      });
      if (!record) return { status: "not_found" };
      const item = plain(record);
      const check = eligibility(item, now);
      if (check.status !== "ready") return check;
      await record.update({ status: "NO_SHOW", updatedAt: now }, { transaction });
      await models.AuditLog.create({
        actorUserId, action: "ADMIN_APPOINTMENT_MARKED_NO_SHOW",
        entityType: "APPOINTMENT", entityId: item.id,
        beforeData: { status: item.status, startsAt: item.startsAt, endsAt: item.endsAt },
        afterData: { status: "NO_SHOW", markedAt: now },
        createdAt: now
      }, { transaction });
      return { status: "marked", markedAt: now, appointment: displayAppointment({ ...item, status: "NO_SHOW" }) };
    });
  } catch {
    return { status: "error" };
  }
}

module.exports = { getNoShowPreview, markAppointmentNoShow };
