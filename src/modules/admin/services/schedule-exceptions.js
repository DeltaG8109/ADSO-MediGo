const { Op } = require("sequelize");

const TIME_ZONE = "America/Bogota";
const CANCELLATION_REASON = "Bloqueo de agenda médica";

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function formatLocalDateTime(value) {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(({ type, value: part }) => [type, part]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function presentException(record) {
  const exception = plain(record);
  const startsAt = new Date(exception.startsAt);
  const endsAt = new Date(exception.endsAt);
  return {
    id: exception.id,
    startsAt: formatLocalDateTime(startsAt),
    endsAt: formatLocalDateTime(endsAt),
    startsLabel: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(startsAt),
    endsLabel: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, dateStyle: "medium", timeStyle: "short" }).format(endsAt),
    reason: exception.reason,
    status: exception.status
  };
}

function presentAppointment(record) {
  const appointment = plain(record);
  const user = plain(plain(appointment.patient)?.user) || {};
  const startsAt = new Date(appointment.startsAt);
  return {
    id: appointment.id,
    patientName: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Paciente",
    email: user.email || null,
    date: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, dateStyle: "long" }).format(startsAt),
    time: new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true }).format(startsAt)
  };
}

function overlaps(appointment, interval) {
  const start = new Date(appointment.startsAt).getTime();
  const end = new Date(appointment.endsAt).getTime();
  return start < interval.endsAt.getTime() && end > interval.startsAt.getTime();
}

async function findAffectedAppointments({ models, doctorId, startsAt, endsAt, now, transaction = null }) {
  const include = [];
  if (models.Patient) include.push({
    model: models.Patient, as: "patient", required: false,
    include: models.User ? [{ model: models.User, as: "user", attributes: ["firstName", "lastName", "email"], required: false }] : []
  });
  const rows = await models.Appointment.findAll({
    where: {
      doctorId, status: "CONFIRMED",
      startsAt: { [Op.gte]: now, [Op.lt]: endsAt },
      endsAt: { [Op.gt]: startsAt }
    },
    include, order: [["startsAt", "ASC"]],
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
  });
  return rows.filter((row) => overlaps(row, { startsAt, endsAt }));
}

async function getAdminScheduleExceptionsPage({ models, doctorId = "" }) {
  const empty = { status: "unavailable", doctors: [], selectedDoctor: null, exceptions: [] };
  if (!models?.Doctor?.findAll || !models?.DoctorScheduleException?.findAll) return empty;
  try {
    const doctorsRows = await models.Doctor.findAll({
      attributes: ["id"],
      include: [
        { model: models.User, as: "user", attributes: ["firstName", "lastName", "status"], where: { role: "DOCTOR" }, required: true },
        { model: models.Specialty, as: "specialty", attributes: ["name"], required: false }
      ],
      order: [["id", "DESC"]]
    });
    const doctors = doctorsRows.map((row) => {
      const doctor = plain(row), user = plain(doctor.user) || {}, specialty = plain(doctor.specialty) || {};
      return {
        id: doctor.id,
        name: [user.firstName, user.lastName].filter(Boolean).join(" "),
        specialtyName: specialty.name || "Sin especialidad",
        accountStatus: user.status
      };
    });
    const selectedDoctor = doctors.find((doctor) => String(doctor.id) === String(doctorId)) || null;
    if (!selectedDoctor) return { status: "ready", doctors, selectedDoctor: null, exceptions: [] };
    const rows = await models.DoctorScheduleException.findAll({
      where: { doctorId: selectedDoctor.id },
      order: [["startsAt", "DESC"]]
    });
    return { status: "ready", doctors, selectedDoctor, exceptions: rows.map(presentException) };
  } catch {
    return { ...empty, status: "error" };
  }
}

async function previewScheduleException({ models, doctorId, startsAt, endsAt, now = new Date() }) {
  if (!models?.Doctor?.findByPk || !models?.Appointment?.findAll) return { status: "unavailable", appointments: [] };
  if (!/^\d+$/.test(String(doctorId || ""))) return { status: "not_found", appointments: [] };
  try {
    const doctor = await models.Doctor.findByPk(doctorId, { attributes: ["id"] });
    if (!doctor) return { status: "not_found", appointments: [] };
    const rows = await findAffectedAppointments({ models, doctorId, startsAt, endsAt, now });
    return { status: "ready", appointments: rows.map(presentAppointment) };
  } catch {
    return { status: "error", appointments: [] };
  }
}

function normalizedIds(value) {
  const values = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return values.map(String).sort();
}

async function saveScheduleException({
  sequelize, models, doctorId, actorUserId, startsAt, endsAt, reason,
  confirmed, confirmedAppointmentIds = [], emailSender = null, now = new Date()
}) {
  if (!sequelize || !models?.Doctor || !models?.DoctorScheduleException || !models?.Appointment || !models?.AuditLog) {
    return { status: "unavailable" };
  }
  if (!/^\d+$/.test(String(doctorId || ""))) return { status: "not_found" };
  if (!(startsAt instanceof Date) || !(endsAt instanceof Date) || startsAt >= endsAt) return { status: "invalid_interval" };

  const result = await sequelize.transaction(async (transaction) => {
    const doctor = await models.Doctor.findByPk(doctorId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!doctor) return { status: "not_found" };
    const affectedRows = await findAffectedAppointments({ models, doctorId, startsAt, endsAt, now, transaction });
    const appointments = affectedRows.map(presentAppointment);
    if (confirmed !== "YES") return { status: "confirmation_required", appointments };
    if (normalizedIds(confirmedAppointmentIds).join(",") !== normalizedIds(appointments.map((item) => item.id)).join(",")) {
      return { status: "preview_changed", appointments };
    }

    const exception = await models.DoctorScheduleException.create({
      doctorId: doctor.id, startsAt, endsAt, reason, status: "ACTIVE", createdAt: now, updatedAt: now
    }, { transaction });
    await models.AuditLog.create({
      actorUserId, action: "DOCTOR_SCHEDULE_EXCEPTION_CREATED",
      entityType: "DOCTOR_SCHEDULE_EXCEPTION", entityId: exception.id,
      beforeData: null,
      afterData: { doctorId: doctor.id, startsAt, endsAt, reason, status: "ACTIVE", affectedAppointmentIds: appointments.map((item) => item.id) },
      createdAt: now
    }, { transaction });

    for (const appointment of affectedRows) {
      const beforeData = {
        status: appointment.status, cancelledAt: appointment.cancelledAt || null,
        cancellationReason: appointment.cancellationReason || null
      };
      appointment.status = "CANCELLED";
      appointment.cancelledAt = now;
      appointment.cancellationReason = CANCELLATION_REASON;
      await appointment.save({ transaction });
      await models.AuditLog.create({
        actorUserId, action: "APPOINTMENT_CANCELLED_BY_SCHEDULE_EXCEPTION",
        entityType: "APPOINTMENT", entityId: appointment.id,
        beforeData,
        afterData: { status: "CANCELLED", cancelledAt: now, cancellationReason: CANCELLATION_REASON, exceptionId: exception.id },
        createdAt: now
      }, { transaction });
    }
    return { status: "saved", exceptionId: exception.id, appointments, cancelled: affectedRows.length };
  });

  if (result.status !== "saved" || !result.cancelled) return { ...result, failedNotifications: 0 };
  const notifications = await Promise.allSettled(result.appointments.map((appointment) => {
    if (!emailSender?.sendAppointmentCancellationNotification || !appointment.email) {
      throw new Error("No hay un medio de notificación disponible.");
    }
    return emailSender.sendAppointmentCancellationNotification({
      to: appointment.email, firstName: appointment.patientName.split(" ")[0],
      appointmentDate: appointment.date, appointmentTime: appointment.time
    });
  }));
  return { ...result, failedNotifications: notifications.filter((item) => item.status === "rejected").length };
}

module.exports = {
  CANCELLATION_REASON, getAdminScheduleExceptionsPage, previewScheduleException,
  saveScheduleException, formatLocalDateTime, overlaps
};
