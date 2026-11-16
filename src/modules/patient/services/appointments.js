const { Op } = require("sequelize");
const { todayInBogota } = require("../../doctor/services/schedule");

const TIME_ZONE = "America/Bogota";
const ACTIVE_APPOINTMENT_STATUSES = ["CONFIRMED", "IN_PROGRESS"];
const SLOT_MINUTES = 30;
const MINIMUM_NOTICE_MINUTES = 30;
const BOOKING_WINDOW_DAYS = 30;

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function parseDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return date.getUTCFullYear() === Number(year) && date.getUTCMonth() === Number(month) - 1
    && date.getUTCDate() === Number(day) ? String(value) : null;
}

function addDays(dateText, days) {
  const [year, month, day] = dateText.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")].join("-");
}

function bogotaLocalToUtc(dateText, timeText) {
  if (!parseDate(dateText) || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(timeText || ""))) return null;
  const [year, month, day] = dateText.split("-").map(Number);
  const [hour, minute] = timeText.split(":").map(Number);
  return new Date(Date.UTC(year, month - 1, day, hour + 5, minute));
}

function dayBounds(dateText) {
  return {
    start: bogotaLocalToUtc(dateText, "00:00"),
    end: bogotaLocalToUtc(addDays(dateText, 1), "00:00")
  };
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, dateStyle: "long" }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("es-CO", { timeZone: TIME_ZONE, hour: "2-digit", minute: "2-digit", hour12: true }).format(date);
}

function isWithinBookingWindow(dateText, now) {
  const today = todayInBogota(now);
  if (!parseDate(dateText) || dateText < today || dateText > addDays(today, BOOKING_WINDOW_DAYS)) return false;
  const bounds = dayBounds(dateText);
  const maximum = now.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  return bounds.start.getTime() <= maximum;
}

function minutes(value) {
  const match = /^(\d{2}):(\d{2})/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : NaN;
}

function intervalOverlaps(startA, endA, startB, endB) {
  return startA.getTime() < endB.getTime() && endA.getTime() > startB.getTime();
}

async function getActiveSpecialties({ models }) {
  if (!models?.Specialty?.findAll) return { status: "unavailable", specialties: [] };
  try {
    const rows = await models.Specialty.findAll({ where: { status: "ACTIVE" }, order: [["name", "ASC"]] });
    return { status: "ready", specialties: rows.map(plain).map((row) => ({ id: row.id, name: row.name })) };
  } catch {
    return { status: "error", specialties: [] };
  }
}

async function getAvailableDoctors({ models, specialtyId }) {
  if (!models?.Doctor?.findAll || !models?.User || !models?.Specialty) return { status: "unavailable", doctors: [] };
  if (!/^\d+$/.test(String(specialtyId || ""))) return { status: "invalid", doctors: [] };
  try {
    const rows = await models.Doctor.findAll({
      where: { specialtyId },
      attributes: ["id", "specialtyId"],
      include: [
        { model: models.User, as: "user", attributes: ["firstName", "lastName"], where: { role: "DOCTOR", status: "ACTIVE" }, required: true },
        { model: models.Specialty, as: "specialty", attributes: ["name"], where: { status: "ACTIVE" }, required: true }
      ],
      order: [["id", "ASC"]]
    });
    return {
      status: "ready",
      doctors: rows.map(plain).map((row) => ({
        id: row.id,
        specialtyId: row.specialtyId,
        name: [plain(row.user)?.firstName, plain(row.user)?.lastName].filter(Boolean).join(" "),
        specialtyName: plain(row.specialty)?.name || ""
      }))
    };
  } catch {
    return { status: "error", doctors: [] };
  }
}

async function getAvailableSlots({ models, doctorId, date, now = new Date(), transaction = null }) {
  if (!models?.Doctor?.findByPk || !models?.DoctorWeeklySchedule?.findAll
    || !models?.DoctorWeeklyScheduleBlock || !models?.Appointment?.findAll
    || !models?.DoctorScheduleException?.findAll) return { status: "unavailable", slots: [] };
  if (!/^\d+$/.test(String(doctorId || ""))) return { status: "not_found", slots: [] };
  if (!isWithinBookingWindow(date, now)) return { status: "invalid_date", slots: [] };
  try {
    const doctor = plain(await models.Doctor.findByPk(doctorId, {
      include: [
        { model: models.User, as: "user", attributes: ["role", "status"], required: true },
        { model: models.Specialty, as: "specialty", attributes: ["status", "name"], required: true }
      ],
      ...(transaction ? { transaction } : {})
    }));
    if (!doctor || plain(doctor.user)?.role !== "DOCTOR" || plain(doctor.user)?.status !== "ACTIVE"
      || plain(doctor.specialty)?.status !== "ACTIVE") return { status: "not_found", slots: [] };

    const schedules = await models.DoctorWeeklySchedule.findAll({
      where: { doctorId, status: "ACTIVE" },
      include: [{
        model: models.DoctorWeeklyScheduleBlock, as: "blocks",
        attributes: ["weekday", "startsAt", "endsAt"], required: false
      }],
      order: [["effectiveFrom", "DESC"]],
      ...(transaction ? { transaction } : {})
    });
    const current = schedules.map(plain).find((schedule) =>
      String(schedule.effectiveFrom).slice(0, 10) <= date
      && (!schedule.effectiveTo || String(schedule.effectiveTo).slice(0, 10) >= date)
    );
    if (!current) return { status: "ready", slots: [] };
    const weekday = new Date(date + "T00:00:00Z").getUTCDay() || 7;
    const blocks = (current.blocks || []).map(plain).filter((block) => Number(block.weekday) === weekday);
    const bounds = dayBounds(date);
    const [appointments, exceptions] = await Promise.all([
      models.Appointment.findAll({
        where: {
          doctorId, status: ACTIVE_APPOINTMENT_STATUSES,
          startsAt: { [Op.lt]: bounds.end }, endsAt: { [Op.gt]: bounds.start }
        },
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
      }),
      models.DoctorScheduleException.findAll({
        where: {
          doctorId, status: "ACTIVE",
          startsAt: { [Op.lt]: bounds.end }, endsAt: { [Op.gt]: bounds.start }
        },
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {})
      })
    ]);
    const existing = appointments.map(plain);
    const blocked = exceptions.map(plain);
    const earliest = now.getTime() + MINIMUM_NOTICE_MINUTES * 60 * 1000;
    const latest = now.getTime() + BOOKING_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const slots = [];
    for (const block of blocks) {
      const startMinute = minutes(block.startsAt);
      const endMinute = minutes(block.endsAt);
      if (!Number.isFinite(startMinute) || !Number.isFinite(endMinute)) continue;
      for (let start = startMinute; start + SLOT_MINUTES <= endMinute; start += SLOT_MINUTES) {
        const time = String(Math.floor(start / 60)).padStart(2, "0") + ":" + String(start % 60).padStart(2, "0");
        const startsAt = bogotaLocalToUtc(date, time);
        const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60 * 1000);
        if (startsAt.getTime() < earliest || startsAt.getTime() > latest) continue;
        const appointmentConflict = existing.some((row) =>
          intervalOverlaps(startsAt, endsAt, new Date(row.startsAt), new Date(row.endsAt))
        );
        const exceptionConflict = blocked.some((row) =>
          intervalOverlaps(startsAt, endsAt, new Date(row.startsAt), new Date(row.endsAt))
        );
        if (!appointmentConflict && !exceptionConflict) {
          slots.push({ time, startsAt, endsAt, label: formatTime(startsAt) });
        }
      }
    }
    return { status: "ready", slots };
  } catch {
    return { status: "error", slots: [] };
  }
}

async function getPatientBookingPage({ models, userId, query = {}, now = new Date() }) {
  const specialtyResult = await getActiveSpecialties({ models });
  const page = {
    status: specialtyResult.status, specialties: specialtyResult.specialties,
    doctors: [], slots: [], selectedSpecialtyId: String(query.specialtyId || ""),
    selectedDoctorId: String(query.doctorId || ""), date: String(query.date || ""),
    time: String(query.time || ""), selectedDoctor: null, selectedSpecialty: null, patientHasUpcoming: false,
    minDate: todayInBogota(now), maxDate: addDays(todayInBogota(now), BOOKING_WINDOW_DAYS)
  };
  if (models?.Patient?.findOne && models?.Appointment?.findOne) {
    try {
      const patient = plain(await models.Patient.findOne({ where: { userId } }));
      if (!patient) return { ...page, status: "error" };
      const upcoming = await models.Appointment.findOne({
        where: { patientId: patient.id, status: "CONFIRMED", startsAt: { [Op.gte]: now } }
      });
      page.patientHasUpcoming = Boolean(upcoming);
    } catch {
      return { ...page, status: "error" };
    }
  }
  if (page.patientHasUpcoming) return page;
  if (page.selectedSpecialtyId) {
    const specialty = page.specialties.find((item) => String(item.id) === page.selectedSpecialtyId);
    if (!specialty) { page.status = "invalid"; return page; }
    page.selectedSpecialty = specialty;
    const doctorsResult = await getAvailableDoctors({ models, specialtyId: page.selectedSpecialtyId });
    if (doctorsResult.status !== "ready") { page.status = doctorsResult.status; return page; }
    page.doctors = doctorsResult.doctors;
  }
  if (page.selectedDoctorId) {
    page.selectedDoctor = page.doctors.find((item) => String(item.id) === page.selectedDoctorId) || null;
    if (!page.selectedDoctor) { page.status = "invalid"; return page; }
  }
  if (page.selectedDoctor && page.date) {
    const slotsResult = await getAvailableSlots({ models, doctorId: page.selectedDoctor.id, date: page.date, now });
    if (slotsResult.status !== "ready") { page.status = slotsResult.status; return page; }
    page.slots = slotsResult.slots;
  }
  if (page.selectedDoctor && page.date && page.time) {
    page.selectedSlot = page.slots.find((item) => item.time === page.time) || null;
    if (!page.selectedSlot) { page.status = "slot_unavailable"; return page; }
  }
  return page;
}

async function bookPatientAppointment({
  sequelize, models, userId, specialtyId, doctorId, date, time, emailSender = null, now = new Date()
}) {
  if (!sequelize || !models?.Patient || !models?.Doctor || !models?.Appointment || !models?.AuditLog) {
    return { status: "unavailable" };
  }
  if (!/^\d+$/.test(String(specialtyId || "")) || !/^\d+$/.test(String(doctorId || ""))) return { status: "invalid" };
  const startsAt = bogotaLocalToUtc(date, time);
  if (!startsAt) return { status: "invalid" };
  const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60 * 1000);
  const result = await sequelize.transaction(async (transaction) => {
    const patient = plain(await models.Patient.findOne({
      where: { userId }, transaction, lock: transaction.LOCK.UPDATE
    }));
    if (!patient) return { status: "patient_not_found" };
    const doctor = plain(await models.Doctor.findByPk(doctorId, {
      transaction, lock: transaction.LOCK.UPDATE,
      include: [
        { model: models.User, as: "user", attributes: ["role", "status"], required: true },
        { model: models.Specialty, as: "specialty", attributes: ["id", "status", "name"], required: true }
      ]
    }));
    if (!doctor || plain(doctor.user)?.role !== "DOCTOR" || plain(doctor.user)?.status !== "ACTIVE"
      || plain(doctor.specialty)?.status !== "ACTIVE"
      || String(doctor.specialtyId) !== String(specialtyId)) return { status: "not_found" };
    const upcoming = await models.Appointment.findOne({
      where: { patientId: patient.id, status: "CONFIRMED", startsAt: { [Op.gte]: now } },
      transaction, lock: transaction.LOCK.UPDATE
    });
    if (upcoming) return { status: "patient_has_upcoming" };
    const availability = await getAvailableSlots({ models, doctorId, date, now, transaction });
    if (availability.status !== "ready") return { status: availability.status };
    const slot = availability.slots.find((item) => item.startsAt.getTime() === startsAt.getTime());
    if (!slot) return { status: "slot_unavailable" };

    const appointment = await models.Appointment.create({
      patientId: patient.id, doctorId: doctor.id, specialtyId: doctor.specialtyId,
      startsAt, endsAt, status: "CONFIRMED", createdByUserId: userId,
      createdAt: now, updatedAt: now
    }, { transaction });
    await models.AuditLog.create({
      actorUserId: userId, action: "PATIENT_APPOINTMENT_BOOKED",
      entityType: "APPOINTMENT", entityId: appointment.id,
      beforeData: null,
      afterData: { patientId: patient.id, doctorId: doctor.id, specialtyId: doctor.specialtyId, startsAt, endsAt, status: "CONFIRMED" },
      createdAt: now
    }, { transaction });
    const patientUser = models.User ? plain(await models.User.findByPk(userId, { attributes: ["firstName", "email"], transaction })) : {};
    const doctorUser = plain(doctor.user) || {};
    return {
      status: "booked", appointmentId: appointment.id,
      appointment: { startsAt, endsAt, date: formatDate(startsAt), time: formatTime(startsAt) },
      patient: patientUser || {}, doctor: { name: [doctorUser.firstName, doctorUser.lastName].filter(Boolean).join(" "), specialtyName: plain(doctor.specialty)?.name }
    };
  });
  if (result.status !== "booked") return result;

  let notificationStatus = "not_configured";
  if (emailSender?.sendAppointmentBookingNotification && result.patient.email) {
    try {
      await emailSender.sendAppointmentBookingNotification({
        to: result.patient.email, firstName: result.patient.firstName,
        doctorName: result.doctor.name, specialtyName: result.doctor.specialtyName,
        appointmentDate: result.appointment.date, appointmentTime: result.appointment.time
      });
      notificationStatus = "sent";
    } catch {
      notificationStatus = "failed";
    }
  }
  try {
    await models.AuditLog.create({
      actorUserId: userId,
      action: "PATIENT_APPOINTMENT_BOOKING_EMAIL_" + notificationStatus.toUpperCase(),
      entityType: "APPOINTMENT", entityId: result.appointmentId,
      beforeData: null, afterData: { status: notificationStatus }, createdAt: new Date()
    });
  } catch {
    notificationStatus = notificationStatus === "sent" ? "sent_audit_failed" : notificationStatus;
  }
  return { ...result, notificationStatus };
}

module.exports = {
  ACTIVE_APPOINTMENT_STATUSES, BOOKING_WINDOW_DAYS, MINIMUM_NOTICE_MINUTES,
  addDays, bogotaLocalToUtc, getActiveSpecialties, getAvailableDoctors,
  getAvailableSlots, getPatientBookingPage, bookPatientAppointment
};
