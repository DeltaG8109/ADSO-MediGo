const { Op } = require("sequelize");
const {
  addDays, bogotaLocalToUtc, getActiveSpecialties, getAvailableDoctors, getAvailableSlots
} = require("../../patient/services/appointments");
const { todayInBogota } = require("../../doctor/services/schedule");

const SLOT_MINUTES = 30;
const BOOKING_WINDOW_DAYS = 30;

function plain(record) {
  return record && typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", dateStyle: "long"
  }).format(date);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("es-CO", {
    timeZone: "America/Bogota", hour: "2-digit", minute: "2-digit", hour12: true
  }).format(date);
}

async function getActivePatients({ models }) {
  if (!models?.Patient?.findAll || !models?.User) return { status: "unavailable", patients: [] };
  try {
    const rows = await models.Patient.findAll({
      attributes: ["id", "userId"],
      include: [{
        model: models.User, as: "user", required: true,
        attributes: ["firstName", "lastName", "documentType", "documentNumber"],
        where: { role: "PATIENT", status: "ACTIVE", emailVerifiedAt: { [Op.ne]: null } }
      }],
      order: [["id", "DESC"]]
    });
    return {
      status: "ready",
      patients: rows.map(plain).map((patient) => {
        const user = plain(patient.user) || {};
        return {
          id: patient.id,
          name: [user.firstName, user.lastName].filter(Boolean).join(" "),
          document: [user.documentType, user.documentNumber].filter(Boolean).join(" ")
        };
      })
    };
  } catch {
    return { status: "error", patients: [] };
  }
}

async function getAdminAppointmentBookingPage({ models, query = {}, now = new Date() }) {
  const [patientResult, specialtyResult] = await Promise.all([
    getActivePatients({ models }),
    getActiveSpecialties({ models })
  ]);
  const today = todayInBogota(now);
  const page = {
    status: patientResult.status !== "ready" ? patientResult.status : specialtyResult.status,
    patients: patientResult.patients,
    specialties: specialtyResult.specialties,
    doctors: [], slots: [],
    selectedPatientId: String(query.patientId || ""),
    selectedSpecialtyId: String(query.specialtyId || ""),
    selectedDoctorId: String(query.doctorId || ""),
    date: String(query.date || ""), time: String(query.time || ""),
    minDate: today, maxDate: addDays(today, BOOKING_WINDOW_DAYS),
    selectedPatient: null, selectedSpecialty: null, selectedDoctor: null, selectedSlot: null
  };
  if (page.status !== "ready") return page;
  if (page.selectedPatientId) {
    page.selectedPatient = page.patients.find((item) => String(item.id) === page.selectedPatientId) || null;
    if (!page.selectedPatient) return { ...page, status: "invalid" };
  }
  if (page.selectedSpecialtyId) {
    page.selectedSpecialty = page.specialties.find((item) => String(item.id) === page.selectedSpecialtyId) || null;
    if (!page.selectedSpecialty) return { ...page, status: "invalid" };
    const doctorResult = await getAvailableDoctors({ models, specialtyId: page.selectedSpecialtyId });
    if (doctorResult.status !== "ready") return { ...page, status: doctorResult.status };
    page.doctors = doctorResult.doctors;
  }
  if (page.selectedDoctorId) {
    page.selectedDoctor = page.doctors.find((item) => String(item.id) === page.selectedDoctorId) || null;
    if (!page.selectedDoctor) return { ...page, status: "invalid" };
  }
  if (page.selectedDoctor && page.date) {
    const slots = await getAvailableSlots({ models, doctorId: page.selectedDoctorId, date: page.date, now });
    if (slots.status !== "ready") return { ...page, status: slots.status };
    page.slots = slots.slots;
    if (page.time) {
      page.selectedSlot = page.slots.find((slot) => slot.time === page.time) || null;
      if (!page.selectedSlot) return { ...page, status: "slot_unavailable" };
    }
  }
  return page;
}

async function createAdminAppointment({
  sequelize, models, actorUserId, patientId, specialtyId, doctorId, date, time,
  emailSender = null, now = new Date()
}) {
  if (!sequelize?.transaction || !models?.Patient || !models?.User || !models?.Doctor
    || !models?.Appointment || !models?.AuditLog) return { status: "unavailable" };
  if (!/^[1-9]\d*$/.test(String(patientId || ""))
    || !/^[1-9]\d*$/.test(String(specialtyId || ""))
    || !/^[1-9]\d*$/.test(String(doctorId || ""))) return { status: "invalid" };
  const startsAt = bogotaLocalToUtc(date, time);
  if (!startsAt) return { status: "invalid" };
  const endsAt = new Date(startsAt.getTime() + SLOT_MINUTES * 60 * 1000);

  let booked;
  try {
    booked = await sequelize.transaction(async (transaction) => {
      const patient = plain(await models.Patient.findByPk(patientId, {
        transaction, lock: transaction.LOCK.UPDATE
      }));
      if (!patient) return { status: "patient_not_found" };
      const patientUser = plain(await models.User.findByPk(patient.userId, {
        attributes: ["id", "firstName", "email", "role", "status", "emailVerifiedAt"],
        transaction, lock: transaction.LOCK.UPDATE
      }));
      if (!patientUser || patientUser.role !== "PATIENT" || patientUser.status !== "ACTIVE"
        || !patientUser.emailVerifiedAt) return { status: "patient_not_found" };

      const doctor = plain(await models.Doctor.findByPk(doctorId, {
        transaction, lock: transaction.LOCK.UPDATE,
        include: [
          { model: models.User, as: "user", attributes: ["firstName", "lastName", "role", "status"], required: true },
          { model: models.Specialty, as: "specialty", attributes: ["id", "name", "status"], required: true }
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
        startsAt, endsAt, status: "CONFIRMED", createdByUserId: actorUserId,
        createdAt: now, updatedAt: now
      }, { transaction });
      await models.AuditLog.create({
        actorUserId, action: "ADMIN_APPOINTMENT_BOOKED",
        entityType: "APPOINTMENT", entityId: appointment.id,
        beforeData: null,
        afterData: {
          patientId: patient.id, doctorId: doctor.id, specialtyId: doctor.specialtyId,
          startsAt, endsAt, status: "CONFIRMED"
        },
        createdAt: now
      }, { transaction });
      return {
        status: "booked", appointmentId: appointment.id,
        patient: patientUser,
        doctor: {
          name: [plain(doctor.user)?.firstName, plain(doctor.user)?.lastName].filter(Boolean).join(" "),
          specialtyName: plain(doctor.specialty)?.name || "Especialidad asignada"
        },
        appointment: { startsAt, endsAt, date: formatDate(startsAt), time: formatTime(startsAt) }
      };
    });
  } catch {
    return { status: "error" };
  }
  if (booked.status !== "booked") return booked;

  let notificationStatus = "not_configured";
  if (emailSender?.sendAppointmentBookingNotification && booked.patient.email) {
    try {
      await emailSender.sendAppointmentBookingNotification({
        to: booked.patient.email, firstName: booked.patient.firstName,
        doctorName: booked.doctor.name, specialtyName: booked.doctor.specialtyName,
        appointmentDate: booked.appointment.date, appointmentTime: booked.appointment.time
      });
      notificationStatus = "sent";
    } catch {
      notificationStatus = "failed";
    }
  }
  try {
    await models.AuditLog.create({
      actorUserId, action: "ADMIN_APPOINTMENT_BOOKING_EMAIL_" + notificationStatus.toUpperCase(),
      entityType: "APPOINTMENT", entityId: booked.appointmentId,
      beforeData: null, afterData: { status: notificationStatus }, createdAt: new Date()
    });
  } catch {
    notificationStatus = notificationStatus === "sent" ? "sent_audit_failed" : notificationStatus;
  }
  return { ...booked, notificationStatus };
}

module.exports = { createAdminAppointment, getActivePatients, getAdminAppointmentBookingPage };
