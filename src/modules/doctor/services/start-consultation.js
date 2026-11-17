async function startDoctorConsultation({ sequelize, models, userId, appointmentId, now = new Date() }) {
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
  if (!sequelize?.transaction || !models?.Doctor?.findOne || !models?.Appointment?.findOne
    || !models?.Consultation?.findOne || !models?.Consultation?.create) return { status: "unavailable" };

  try {
    return await sequelize.transaction(async (transaction) => {
      const doctor = await models.Doctor.findOne({
        where: { userId }, attributes: ["id"], transaction, lock: transaction.LOCK.UPDATE
      });
      if (!doctor) return { status: "not_found" };

      const appointment = await models.Appointment.findOne({
        where: { id: appointmentId, doctorId: doctor.id },
        attributes: ["id", "doctorId", "startsAt", "endsAt", "status"],
        transaction, lock: transaction.LOCK.UPDATE
      });
      if (!appointment) return { status: "not_found" };
      if (appointment.status !== "CONFIRMED") return { status: "invalid_state" };

      const startsAt = new Date(appointment.startsAt);
      const endsAt = new Date(appointment.endsAt);
      if (!Number.isFinite(startsAt.getTime()) || !Number.isFinite(endsAt.getTime())) {
        return { status: "error" };
      }
      if (now.getTime() < startsAt.getTime() || now.getTime() >= endsAt.getTime()) {
        return { status: "outside_window" };
      }

      const existing = await models.Consultation.findOne({
        where: { appointmentId: appointment.id }, transaction, lock: transaction.LOCK.UPDATE
      });
      if (existing) return { status: "already_started" };

      await appointment.update({ status: "IN_PROGRESS", updatedAt: now }, { transaction });
      const consultation = await models.Consultation.create({
        appointmentId: appointment.id, doctorId: doctor.id, status: "IN_PROGRESS",
        notes: null, startedAt: now, completedAt: null, createdAt: now, updatedAt: now
      }, { transaction });
      return { status: "started", appointmentId: appointment.id, startedAt: consultation.startedAt || now };
    });
  } catch {
    return { status: "error" };
  }
}

module.exports = { startDoctorConsultation };
