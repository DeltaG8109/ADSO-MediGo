const path = require("node:path");
const pug = require("pug");
const {
  getPatientReschedulePage,
  reschedulePatientAppointment
} = require("../src/modules/patient/services/reschedule-appointment");

const now = new Date("2026-11-16T12:00:00.000Z");
const doctor = {
  id: 9,
  specialtyId: 3,
  user: { role: "DOCTOR", status: "ACTIVE", firstName: "Carlos", lastName: "Méndez" },
  specialty: { id: 3, name: "Medicina general", status: "ACTIVE" }
};

function rescheduleModels({
  startsAt = new Date("2026-11-20T14:00:00.000Z"),
  status = "CONFIRMED",
  occupiedSlots = []
} = {}) {
  const appointment = {
    id: 31,
    patientId: 81,
    doctorId: 9,
    specialtyId: 3,
    status,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60 * 1000),
    doctor,
    specialty: doctor.specialty,
    update: jest.fn(async function update(values) { Object.assign(this, values); })
  };
  return {
    Patient: { findOne: jest.fn().mockResolvedValue({ id: 81, userId: 22 }) },
    User: { findByPk: jest.fn().mockResolvedValue({ firstName: "Laura", email: "laura@example.com" }) },
    Doctor: { findByPk: jest.fn().mockResolvedValue(doctor) },
    Specialty: {},
    DoctorWeeklySchedule: {
      findAll: jest.fn().mockResolvedValue([{
        effectiveFrom: "2026-11-01",
        effectiveTo: null,
        blocks: [{ weekday: 2, startsAt: "09:00:00", endsAt: "10:00:00" }]
      }])
    },
    DoctorWeeklyScheduleBlock: {},
    DoctorScheduleException: { findAll: jest.fn().mockResolvedValue([]) },
    Appointment: {
      findOne: jest.fn().mockResolvedValue(appointment),
      findAll: jest.fn().mockResolvedValue(occupiedSlots)
    },
    AuditLog: { create: jest.fn().mockResolvedValue({}) },
    appointment
  };
}

function transactionHarness() {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  return { transaction, sequelize: { transaction: jest.fn((callback) => callback(transaction)) } };
}

describe("patient appointment rescheduling", () => {
  test("compiles the rescheduling screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/patient/views/appointment-reschedule.pug"))).not.toThrow();
  });

  test("shows only available times for the patient's appointment and keeps its doctor", async () => {
    const models = rescheduleModels();

    const page = await getPatientReschedulePage({
      models, userId: 22, appointmentId: "31", query: { date: "2026-11-17" }, now
    });

    expect(page.status).toBe("ready");
    expect(page.appointment.doctorName).toBe("Carlos Méndez");
    expect(page.slots.map((slot) => slot.time)).toEqual(["09:00", "09:30"]);
    expect(models.Appointment.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "31", patientId: 81 }
    }));
    expect(models.Doctor.findByPk).toHaveBeenCalledWith("9", expect.any(Object));
  });

  test("revalidates availability in a transaction and records the change and actor", async () => {
    const models = rescheduleModels();
    const { sequelize, transaction } = transactionHarness();
    const sendEmail = jest.fn().mockResolvedValue(undefined);

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "09:30",
      emailSender: { sendAppointmentRescheduleNotification: sendEmail }, now
    });

    expect(result).toMatchObject({
      status: "rescheduled", notificationStatus: "sent", appointmentId: 31,
      appointment: { startsAt: new Date("2026-11-17T14:30:00.000Z"), endsAt: new Date("2026-11-17T15:00:00.000Z") }
    });
    expect(models.appointment.update).toHaveBeenCalledWith(expect.objectContaining({
      startsAt: new Date("2026-11-17T14:30:00.000Z"),
      endsAt: new Date("2026-11-17T15:00:00.000Z")
    }), { transaction });
    expect(models.appointment.update.mock.calls[0][0]).not.toHaveProperty("doctorId");
    expect(models.appointment.update.mock.calls[0][0]).not.toHaveProperty("specialtyId");
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 22,
      action: "PATIENT_APPOINTMENT_RESCHEDULED",
      entityId: 31,
      beforeData: expect.objectContaining({ startsAt: new Date("2026-11-20T14:00:00.000Z") }),
      afterData: expect.objectContaining({ startsAt: new Date("2026-11-17T14:30:00.000Z") })
    }), { transaction });
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "laura@example.com",
      previousDate: expect.any(String),
      appointmentDate: expect.any(String)
    }));
  });

  test("keeps the original appointment when another appointment occupies the new slot", async () => {
    const occupied = {
      startsAt: new Date("2026-11-17T14:30:00.000Z"),
      endsAt: new Date("2026-11-17T15:00:00.000Z")
    };
    const models = rescheduleModels({ occupiedSlots: [occupied] });
    const { sequelize } = transactionHarness();

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "09:30", now
    });

    expect(result.status).toBe("slot_unavailable");
    expect(models.appointment.update).not.toHaveBeenCalled();
    expect(models.AuditLog.create).not.toHaveBeenCalled();
  });

  test("does not reschedule when the current appointment is inside the 24-hour window", async () => {
    const models = rescheduleModels({
      startsAt: new Date(now.getTime() + 23 * 60 * 60 * 1000)
    });
    const { sequelize } = transactionHarness();

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "09:30", now
    });

    expect(result.status).toBe("not_reschedulable");
    expect(models.appointment.update).not.toHaveBeenCalled();
  });

  test("does not reschedule an appointment that is no longer confirmed", async () => {
    const models = rescheduleModels({ status: "CANCELLED" });
    const { sequelize } = transactionHarness();

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "09:30", now
    });

    expect(result.status).toBe("not_reschedulable");
    expect(models.appointment.update).not.toHaveBeenCalled();
  });

  test("rejects malformed dates or times before opening a transaction", async () => {
    const models = rescheduleModels();
    const { sequelize } = transactionHarness();

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "25:99", now
    });

    expect(result.status).toBe("invalid");
    expect(sequelize.transaction).not.toHaveBeenCalled();
  });

  test("keeps the new time when the notification email fails", async () => {
    const models = rescheduleModels();
    const { sequelize } = transactionHarness();

    const result = await reschedulePatientAppointment({
      sequelize, models, userId: 22, appointmentId: "31",
      date: "2026-11-17", time: "09:30",
      emailSender: { sendAppointmentRescheduleNotification: jest.fn().mockRejectedValue(new Error("SMTP down")) },
      now
    });

    expect(result).toMatchObject({ status: "rescheduled", notificationStatus: "failed" });
    expect(models.appointment.update).toHaveBeenCalled();
    expect(models.AuditLog.create).toHaveBeenLastCalledWith(expect.objectContaining({
      action: "PATIENT_APPOINTMENT_RESCHEDULE_EMAIL_FAILED",
      afterData: { status: "failed" }
    }));
  });
});
