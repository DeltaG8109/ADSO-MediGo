const path = require("node:path");
const pug = require("pug");
const {
  bogotaLocalToUtc, getAvailableSlots, getPatientBookingPage, bookPatientAppointment
} = require("../src/modules/patient/services/appointments");

const now = new Date("2026-11-16T12:00:00.000Z");
const doctor = {
  id: 9, specialtyId: 3,
  user: { role: "DOCTOR", status: "ACTIVE", firstName: "Carlos", lastName: "Méndez" },
  specialty: { id: 3, name: "Medicina general", status: "ACTIVE" }
};

function bookingModels({ appointments = [], exceptions = [], upcoming = null } = {}) {
  const schedule = {
    effectiveFrom: "2026-11-01", effectiveTo: null,
    blocks: [{ weekday: 2, startsAt: "09:00:00", endsAt: "10:00:00" }]
  };
  return {
    Patient: { findOne: jest.fn().mockResolvedValue({ id: 81, userId: 12 }) },
    User: { findByPk: jest.fn().mockResolvedValue({ firstName: "Laura", email: "laura@example.com" }) },
    Specialty: { findAll: jest.fn().mockResolvedValue([{ id: 3, name: "Medicina general", status: "ACTIVE" }]) },
    Doctor: {
      findAll: jest.fn().mockResolvedValue([doctor]),
      findByPk: jest.fn().mockResolvedValue(doctor)
    },
    DoctorWeeklySchedule: { findAll: jest.fn().mockResolvedValue([schedule]) },
    DoctorWeeklyScheduleBlock: {},
    DoctorScheduleException: { findAll: jest.fn().mockResolvedValue(exceptions) },
    Appointment: {
      findOne: jest.fn().mockResolvedValue(upcoming),
      findAll: jest.fn().mockResolvedValue(appointments),
      create: jest.fn().mockResolvedValue({ id: 101 })
    },
    AuditLog: { create: jest.fn().mockResolvedValue({}) }
  };
}

function transactionHarness() {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  return { transaction, sequelize: { transaction: (callback) => callback(transaction) } };
}

describe("patient appointment booking", () => {
  test("compiles the reservation screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/patient/views/appointment-booking.pug"))).not.toThrow();
  });

  test("converts local Colombia date and time to UTC", () => {
    expect(bogotaLocalToUtc("2026-11-17", "09:00").toISOString()).toBe("2026-11-17T14:00:00.000Z");
    expect(bogotaLocalToUtc("2026-02-30", "09:00")).toBeNull();
  });

  test("generates half-hour slots within weekly availability", async () => {
    const models = bookingModels();
    const result = await getAvailableSlots({ models, doctorId: "9", date: "2026-11-17", now });
    expect(result.status).toBe("ready");
    expect(result.slots.map((slot) => slot.time)).toEqual(["09:00", "09:30"]);
  });

  test("excludes slots that overlap existing appointments or active exceptions", async () => {
    const models = bookingModels({
      appointments: [{ startsAt: new Date("2026-11-17T14:00:00Z"), endsAt: new Date("2026-11-17T14:30:00Z") }],
      exceptions: [{ startsAt: new Date("2026-11-17T14:30:00Z"), endsAt: new Date("2026-11-17T15:00:00Z") }]
    });
    const result = await getAvailableSlots({ models, doctorId: "9", date: "2026-11-17", now });
    expect(result.slots).toEqual([]);
  });

  test("prevents a second future confirmed appointment for the patient", async () => {
    const models = bookingModels({ upcoming: { id: 7 } });
    const result = await getPatientBookingPage({ models, userId: 12, now });
    expect(result.patientHasUpcoming).toBe(true);
    expect(models.Doctor.findAll).not.toHaveBeenCalled();
  });

  test("revalidates the slot in a transaction and records the confirmed booking", async () => {
    const { sequelize, transaction } = transactionHarness();
    const models = bookingModels();
    const sendEmail = jest.fn().mockResolvedValue(undefined);
    const result = await bookPatientAppointment({
      sequelize, models, userId: 12, specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:00", emailSender: { sendAppointmentBookingNotification: sendEmail }, now
    });
    expect(result).toMatchObject({ status: "booked", appointmentId: 101, notificationStatus: "sent" });
    expect(models.Patient.findOne).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: 12 }, transaction, lock: "UPDATE"
    }));
    expect(models.Appointment.create).toHaveBeenCalledWith(expect.objectContaining({
      patientId: 81, doctorId: 9, specialtyId: 3,
      startsAt: new Date("2026-11-17T14:00:00.000Z"),
      endsAt: new Date("2026-11-17T14:30:00.000Z"), status: "CONFIRMED"
    }), { transaction });
    expect(models.AuditLog.create).toHaveBeenCalledTimes(2);
    expect(sendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: "laura@example.com", appointmentTime: expect.any(String)
    }));
  });

  test("does not create a booking if another patient takes the selected slot", async () => {
    const { sequelize } = transactionHarness();
    const models = bookingModels({
      appointments: [{ startsAt: new Date("2026-11-17T14:00:00Z"), endsAt: new Date("2026-11-17T14:30:00Z") }]
    });
    const result = await bookPatientAppointment({
      sequelize, models, userId: 12, specialtyId: "3", doctorId: "9",
      date: "2026-11-17", time: "09:00", now
    });
    expect(result.status).toBe("slot_unavailable");
    expect(models.Appointment.create).not.toHaveBeenCalled();
  });
});
