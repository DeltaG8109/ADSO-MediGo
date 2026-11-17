async function finishDoctorConsultation({ sequelize, models, userId, appointmentId, now = new Date() }) {
  if (!/^[1-9]\d*$/.test(String(appointmentId || ""))) return { status: "invalid" };
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

      if (appointment.status === "ATTENDED" && consultation.status === "COMPLETED") {
        return { status: "already_completed" };
      }
      if (appointment.status !== "IN_PROGRESS" || consultation.status !== "IN_PROGRESS") {
        return { status: "invalid_state" };
      }

      await appointment.update({ status: "ATTENDED", updatedAt: now }, { transaction });
      await consultation.update({
        status: "COMPLETED", completedAt: now, updatedAt: now
      }, { transaction });
      return { status: "finished", appointmentId: appointment.id, completedAt: now };
    });
  } catch {
    return { status: "error" };
  }
}

module.exports = { finishDoctorConsultation };
