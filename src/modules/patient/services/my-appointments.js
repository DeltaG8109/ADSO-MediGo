const { Op } = require("sequelize");

const APPOINTMENT_FILTERS = ["proximas", "anteriores", "todas"];
const STATUS_LABELS = {
  CONFIRMED: "Confirmada",
  IN_PROGRESS: "En curso",
  ATTENDED: "Atendida",
  CANCELLED: "Cancelada",
  NO_SHOW: "No asistió"
};
const TIME_ZONE = "America/Bogota";
const ACTION_WINDOW_MS = 24 * 60 * 60 * 1000;

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function appointmentIncludes(models) {
  const include = [];
  if (models.Doctor) {
    include.push({
      model: models.Doctor, as: "doctor", required: false,
      include: models.User
        ? [{ model: models.User, as: "user", attributes: ["firstName", "lastName"], required: false }]
        : []
    });
  }
  if (models.Specialty) include.push({ model: models.Specialty, as: "specialty", attributes: ["name"], required: false });
  return include;
}

function presentAppointment(record, now) {
  const item = plain(record);
  const doctor = plain(item.doctor) || {};
  const doctorUser = plain(doctor.user) || {};
  const specialty = plain(item.specialty) || {};
  const startsAt = new Date(item.startsAt);
  const endsAt = new Date(item.endsAt);
  const validStart = Number.isFinite(startsAt.getTime());
  const canChange = item.status === "CONFIRMED" && validStart
    && startsAt.getTime() - now.getTime() >= ACTION_WINDOW_MS;
  return {
    id: item.id,
    doctorName: [doctorUser.firstName, doctorUser.lastName].filter(Boolean).join(" ") || "Médico asignado",
    specialtyName: specialty.name || "Especialidad asignada",
    startsAt,
    endsAt,
    date: validStart ? new Intl.DateTimeFormat("es-CO", {
      timeZone: TIME_ZONE, weekday: "long", day: "numeric", month: "long", year: "numeric"
    }).format(startsAt) : "Fecha no disponible",
    time: validStart ? new Intl.DateTimeFormat("es-CO", {
      timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true
    }).format(startsAt) : "",
    status: STATUS_LABELS[item.status] || "Estado no disponible",
    canCancel: canChange,
    canReschedule: canChange
  };
}

async function getPatientAppointments({ models, userId, filter = "proximas", now = new Date() }) {
  const safeFilter = String(filter || "proximas");
  if (!APPOINTMENT_FILTERS.includes(safeFilter)) {
    return { status: "invalid", filter: safeFilter, appointments: [], filters: APPOINTMENT_FILTERS };
  }
  if (!models?.Patient?.findOne || !models?.Appointment?.findAll) {
    return { status: "unavailable", filter: safeFilter, appointments: [], filters: APPOINTMENT_FILTERS };
  }
  try {
    const patient = plain(await models.Patient.findOne({ where: { userId } }));
    if (!patient) return { status: "not_found", filter: safeFilter, appointments: [], filters: APPOINTMENT_FILTERS };
    const where = { patientId: patient.id };
    if (safeFilter === "proximas") where.startsAt = { [Op.gte]: now };
    if (safeFilter === "anteriores") where.startsAt = { [Op.lt]: now };
    const records = await models.Appointment.findAll({
      where, include: appointmentIncludes(models),
      order: [["startsAt", safeFilter === "anteriores" ? "DESC" : "ASC"]]
    });
    return {
      status: "ready", filter: safeFilter, filters: APPOINTMENT_FILTERS,
      appointments: records.map((record) => presentAppointment(record, now))
    };
  } catch {
    return { status: "error", filter: safeFilter, appointments: [], filters: APPOINTMENT_FILTERS };
  }
}

module.exports = { APPOINTMENT_FILTERS, STATUS_LABELS, getPatientAppointments, presentAppointment };
