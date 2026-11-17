const { Op } = require("sequelize");
const { bogotaLocalToUtc, getAvailableSlots } = require("../../patient/services/appointments");

const CHANGE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SLOT_MINUTES = 30;
const TIME_ZONE = "America/Bogota";

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric"
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true
  }).format(date);
}

function canChange(appointment, now) {
  const startsAt = new Date(appointment.startsAt);
  return appointment.status === "CONFIRMED"
    && Number.isFinite(startsAt.getTime())
    && startsAt.getTime() - now.getTime() >= CHANGE_WINDOW_MS;
}

function appointmentIncludes(models) {
  return [
    {
      model: models.Patient, as: "patient", required: false, attributes: ["id", "userId"],
      include: models.User ? [{
        model: models.User, as: "user", required: false,
        attributes: ["firstName", "lastName", "email"]
      }] : []
    },
    {
      model: models.Doctor, as: "doctor", required: false, attributes: ["id", "userId"],
      include: models.User ? [{
        model: models.User, as: "user", required: false,
        attributes: ["firstName", "lastName"]
      }] : []
    },
    models.Specialty ? { model: models.Specialty, as: "specialty", required: false, attributes: ["id", "name"] } : null
  ].filter(Boolean);
}

function presentAppointment(record, now) {
  const item = plain(record);
  const patient = plain(item.patient) || {};
  const patientUser = plain(patient.user) || {};
  const doctor = plain(item.doctor) || {};
  const doctorUser = plain(doctor.user) || {};
  const specialty = plain(item.specialty) || {};
  const startsAt = new Date(item.startsAt);
  const validStart = Number.isFinite(startsAt.getTime());
  return {
    id: item.id, status: item.status, doctorId: item.doctorId, specialtyId: item.specialtyId,
    startsAt, endsAt: new Date(item.endsAt),
    date: validStart ? formatDate(startsAt) : "Fecha no disponible",
    time: validStart ? formatTime(startsAt) : "",
    patientName: [patientUser.firstName, patientUser.lastName].filter(Boolean).join(" ") || "Paciente",
    doctorName: [doctorUser.firstName, doctorUser.lastName].filter(Boolean).join(" ") || "Médico asignado",
    specialtyName: specialty.name || "Especialidad asignada",
    canChange: canChange(item, now)
  };
}

async function getAdminAppointmentChangePage({ models, appointmentId, date = "", now = new Date() }) {
  const page = { status: "unavailable", appointment: null, slots: [], date: String(date || "") };
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { ...page, status: "invalid" };
  if (!models?.Appointment?.findByPk || !models?.Doctor) return page;
  try {
    const record = await models.Appointment.findByPk(appointmentId, {
      attributes: ["id", "patientId", "doctorId", "specialtyId", "startsAt", "endsAt", "status"],
      include: appointmentIncludes(models)
    });
    if (!record) return { ...page, status: "not_found" };
    const appointment = presentAppointment(record, now);
    if (!appointment.canChange) return { ...page, status: "not_changeable", appointment };
    if (!page.date) return { ...page, status: "ready", appointment };
    const available = await getAvailableSlots({
      models, doctorId: appointment.doctorId, date: page.date, now
    });
    if (available.status !== "ready") return { ...page, status: available.status, appointment };
    return { ...page, status: "ready", appointment, slots: available.slots };
  } catch {
    return { ...page, status: "error" };
  }
}

async function previewAdminAppointmentChange({
  models, appointmentId, action, reason, date = "", time = "", now = new Date()
}) {
  const normalizedReason = String(reason || "").trim();
  if (!["cancel", "reschedule"].includes(action) || normalizedReason.length < 3 || normalizedReason.length > 255) {
    return { status: "invalid" };
  }
  const page = await getAdminAppointmentChangePage({ models, appointmentId, date, now });
  if (page.status !== "ready") return page;
  if (action === "reschedule") {
    const startsAt = bogotaLocalToUtc(date, time);
    if (!startsAt) return { ...page, status: "invalid" };
    const slot = page.slots.find((item) => item.startsAt.getTime() === startsAt.getTime());
    if (!slot) return { ...page, status: "slot_unavailable" };
    return { status: "ready", action, reason: normalizedReason, appointment: page.appointment, slot };
  }
  return { status: "ready", action, reason: normalizedReason, appointment: page.appointment };
}

async function changeAppointment({
  sequelize, models, actorUserId, appointmentId, action, reason,
  date = "", time = "", emailSender = null, now = new Date()
}) {
  const normalizedReason = String(reason || "").trim();
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
  if (normalizedReason.length < 3 || normalizedReason.length > 255) return { status: "invalid_reason" };
  if (!sequelize?.transaction || !models?.Appointment?.findByPk || !models?.AuditLog?.create
    || !models?.User?.findByPk) return { status: "unavailable" };
  const startsAt = action === "reschedule" ? bogotaLocalToUtc(date, time) : null;
  if (action === "reschedule" && !startsAt) return { status: "invalid" };
  if (!["cancel", "reschedule"].includes(action)) return { status: "invalid" };

  let result;
  try {
    result = await sequelize.transaction(async (transaction) => {
      const record = await models.Appointment.findByPk(appointmentId, {
        transaction, lock: transaction.LOCK.UPDATE, include: appointmentIncludes(models)
      });
      if (!record) return { status: "not_found" };
      const item = plain(record);
      if (!canChange(item, now)) return { status: "not_changeable" };
      const oldStartsAt = new Date(item.startsAt);
      const oldEndsAt = new Date(item.endsAt);
      const beforeData = { status: item.status, startsAt: item.startsAt, endsAt: item.endsAt };
      const patient = plain(item.patient) || {};
      const patientUser = plain(patient.user) || {};

      if (action === "cancel") {
        await record.update({
          status: "CANCELLED", cancelledAt: now, cancellationReason: normalizedReason, updatedAt: now
        }, { transaction });
        await models.AuditLog.create({
          actorUserId, action: "ADMIN_APPOINTMENT_CANCELLED", entityType: "APPOINTMENT",
          entityId: item.id, beforeData,
          afterData: { status: "CANCELLED", startsAt: item.startsAt, endsAt: item.endsAt, reason: normalizedReason },
          createdAt: now
        }, { transaction });
        return {
          status: "cancelled", appointmentId: item.id, patient: patientUser,
          appointment: { date: formatDate(oldStartsAt), time: formatTime(oldStartsAt) },
          reason: normalizedReason
        };
      }

      if (startsAt.getTime() === oldStartsAt.getTime()) return { status: "no_change" };
      const availability = await getAvailableSlots({
        models, doctorId: item.doctorId, date, now, transaction
      });
      if (availability.status !== "ready") return { status: availability.status };
      const slot = availability.slots.find((entry) => entry.startsAt.getTime() === startsAt.getTime());
      if (!slot) return { status: "slot_unavailable" };
      const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60 * 1000);
      await record.update({ startsAt, endsAt, updatedAt: now }, { transaction });
      await models.AuditLog.create({
        actorUserId, action: "ADMIN_APPOINTMENT_RESCHEDULED", entityType: "APPOINTMENT",
        entityId: item.id, beforeData,
        afterData: { status: "CONFIRMED", startsAt, endsAt, reason: normalizedReason },
        createdAt: now
      }, { transaction });
      return {
        status: "rescheduled", appointmentId: item.id, patient: patientUser,
        doctorName: [plain(item.doctor)?.user?.firstName, plain(item.doctor)?.user?.lastName].filter(Boolean).join(" "),
        specialtyName: plain(item.specialty)?.name || "Especialidad asignada",
        previous: { date: formatDate(oldStartsAt), time: formatTime(oldStartsAt) },
        appointment: { date: formatDate(startsAt), time: formatTime(startsAt) },
        reason: normalizedReason
      };
    });
  } catch {
    return { status: "error" };
  }
  if (result.status !== "cancelled" && result.status !== "rescheduled") return result;

  let notificationStatus = "not_configured";
  const notificationMethod = action === "cancel"
    ? emailSender?.sendAppointmentCancellationNotification
    : emailSender?.sendAppointmentRescheduleNotification;
  if (notificationMethod && result.patient.email) {
    try {
      if (action === "cancel") {
        await notificationMethod.call(emailSender, {
          to: result.patient.email, firstName: result.patient.firstName,
          appointmentDate: result.appointment.date, appointmentTime: result.appointment.time
        });
      } else {
        await notificationMethod.call(emailSender, {
          to: result.patient.email, firstName: result.patient.firstName,
          doctorName: result.doctorName, specialtyName: result.specialtyName,
          previousDate: result.previous.date, previousTime: result.previous.time,
          appointmentDate: result.appointment.date, appointmentTime: result.appointment.time
        });
      }
      notificationStatus = "sent";
    } catch {
      notificationStatus = "failed";
    }
  }
  try {
    await models.AuditLog.create({
      actorUserId,
      action: "ADMIN_APPOINTMENT_" + (action === "cancel" ? "CANCELLATION" : "RESCHEDULE") + "_EMAIL_" + notificationStatus.toUpperCase(),
      entityType: "APPOINTMENT", entityId: result.appointmentId,
      beforeData: null, afterData: { status: notificationStatus }, createdAt: new Date()
    });
  } catch {
    notificationStatus = notificationStatus === "sent" ? "sent_audit_failed" : notificationStatus;
  }
  return { ...result, notificationStatus };
}

module.exports = {
  CHANGE_WINDOW_MS, changeAppointment, getAdminAppointmentChangePage, previewAdminAppointmentChange
};
