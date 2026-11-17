const { Op } = require("sequelize");

const PAGE_SIZE = 20;
const TIME_ZONE = "America/Bogota";
const ALLOWED_STATUSES = new Set(["CONFIRMED", "IN_PROGRESS", "ATTENDED", "CANCELLED", "NO_SHOW"]);
const STATUS_LABELS = {
  CONFIRMED: "Confirmada",
  IN_PROGRESS: "En curso",
  ATTENDED: "Atendida",
  CANCELLED: "Cancelada",
  NO_SHOW: "No asistió"
};

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function normalizeSearch(value) {
  return String(value || "").trim().slice(0, 80);
}

function validDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(date + "T00:00:00.000Z");
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
}

function appointmentDateRange(date) {
  const startsAt = new Date(date + "T05:00:00.000Z");
  return { [Op.gte]: startsAt, [Op.lt]: new Date(startsAt.getTime() + 24 * 60 * 60 * 1000) };
}

function appointmentIncludes(models) {
  return [
    {
      model: models.Patient, as: "patient", required: true, attributes: ["id"],
      include: [{
        model: models.User, as: "user", required: true,
        attributes: ["firstName", "lastName", "documentType", "documentNumber"],
        where: { role: "PATIENT" }
      }]
    },
    {
      model: models.Doctor, as: "doctor", required: true, attributes: ["id"],
      include: [{
        model: models.User, as: "user", required: true,
        attributes: ["firstName", "lastName"], where: { role: "DOCTOR" }
      }]
    },
    { model: models.Specialty, as: "specialty", required: false, attributes: ["id", "name"] }
  ];
}

function presentAppointment(record) {
  const appointment = plain(record);
  const patient = plain(appointment.patient) || {};
  const patientUser = plain(patient.user) || {};
  const doctor = plain(appointment.doctor) || {};
  const doctorUser = plain(doctor.user) || {};
  const specialty = plain(appointment.specialty) || {};
  const startsAt = new Date(appointment.startsAt);
  const validStart = Number.isFinite(startsAt.getTime());
  return {
    id: appointment.id,
    patientName: [patientUser.firstName, patientUser.lastName].filter(Boolean).join(" ") || "Paciente",
    patientDocument: [patientUser.documentType, patientUser.documentNumber].filter(Boolean).join(" ") || "—",
    doctorName: [doctorUser.firstName, doctorUser.lastName].filter(Boolean).join(" ") || "Médico asignado",
    specialtyName: specialty.name || "Especialidad asignada",
    date: validStart ? new Intl.DateTimeFormat("es-CO", {
      timeZone: TIME_ZONE, weekday: "short", day: "numeric", month: "short", year: "numeric"
    }).format(startsAt) : "Fecha no disponible",
    time: validStart ? new Intl.DateTimeFormat("es-CO", {
      timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true
    }).format(startsAt) : "",
    status: STATUS_LABELS[appointment.status] || "Estado no disponible"
  };
}

async function getAdminAppointments({ models, search = "", date = "", status = "", specialtyId = "", page = 1 }) {
  const normalizedSearch = normalizeSearch(search);
  const selectedStatus = status ? String(status) : "";
  const selectedDate = String(date || "");
  const selectedSpecialty = String(specialtyId || "");
  const currentPage = Math.max(1, Number.parseInt(page, 10) || 1);
  const empty = {
    status: "unavailable", appointments: [], specialties: [], search: normalizedSearch,
    selectedDate, selectedStatus, selectedSpecialty, page: currentPage, pageCount: 1, total: 0
  };
  if ((selectedStatus && !ALLOWED_STATUSES.has(selectedStatus))
    || (selectedSpecialty && !/^\d+$/.test(selectedSpecialty))) {
    return { ...empty, status: "invalid" };
  }
  if (selectedDate && !validDate(selectedDate)) return { ...empty, status: "invalid_date" };
  if (!models?.Appointment?.findAndCountAll || !models?.Patient || !models?.Doctor
    || !models?.User || !models?.Specialty?.findAll) return empty;

  try {
    const where = {};
    if (selectedStatus) where.status = selectedStatus;
    if (selectedDate) where.startsAt = appointmentDateRange(selectedDate);
    if (selectedSpecialty) where.specialtyId = selectedSpecialty;
    if (normalizedSearch) {
      const pattern = "%" + normalizedSearch.replace(/[\\%_]/g, "\\\\\\$&") + "%";
      where[Op.or] = [
        { "$patient.user.firstName$": { [Op.like]: pattern } },
        { "$patient.user.lastName$": { [Op.like]: pattern } },
        { "$patient.user.documentNumber$": { [Op.like]: pattern } },
        { "$doctor.user.firstName$": { [Op.like]: pattern } },
        { "$doctor.user.lastName$": { [Op.like]: pattern } }
      ];
    }
    const [result, specialties] = await Promise.all([
      models.Appointment.findAndCountAll({
        attributes: ["id", "patientId", "doctorId", "specialtyId", "startsAt", "endsAt", "status"],
        include: appointmentIncludes(models),
        where,
        order: [["startsAt", "DESC"], ["id", "DESC"]],
        limit: PAGE_SIZE,
        offset: (currentPage - 1) * PAGE_SIZE,
        distinct: true,
        subQuery: false
      }),
      models.Specialty.findAll({ attributes: ["id", "name"], order: [["name", "ASC"]] })
    ]);
    const total = Number(result.count) || 0;
    return {
      status: "ready",
      appointments: (result.rows || []).map(presentAppointment),
      specialties: (specialties || []).map(plain),
      search: normalizedSearch, selectedDate, selectedStatus, selectedSpecialty,
      page: currentPage, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), total
    };
  } catch {
    return { ...empty, status: "error" };
  }
}

module.exports = { PAGE_SIZE, STATUS_LABELS, getAdminAppointments, normalizeSearch, presentAppointment, validDate };
