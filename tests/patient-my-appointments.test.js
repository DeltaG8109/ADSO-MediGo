const { Op } = require("sequelize");
const {
  getPatientAppointments,
  presentAppointment
} = require("../src/modules/patient/services/my-appointments");

const now = new Date("2026-11-16T12:00:00.000Z");

function modelsFor(records = []) {
  return {
    Patient: { findOne: jest.fn().mockResolvedValue({ id: 7 }) },
    Doctor: {},
    Specialty: {},
    Appointment: { findAll: jest.fn().mockResolvedValue(records) }
  };
}

describe("patient appointment list", () => {
  test("limits the query to the signed-in patient's profile and upcoming dates", async () => {
    const models = modelsFor();

    const result = await getPatientAppointments({ models, userId: 42, now });

    expect(result.status).toBe("ready");
    expect(models.Patient.findOne).toHaveBeenCalledWith({ where: { userId: 42 } });
    const options = models.Appointment.findAll.mock.calls[0][0];
    expect(options.where.patientId).toBe(7);
    const range = options.where.startsAt;
    expect(range[Op.gte]).toEqual(now);
    expect(options.order).toEqual([["startsAt", "ASC"]]);
  });

  test("filters earlier appointments and orders them from newest to oldest", async () => {
    const models = modelsFor();

    await getPatientAppointments({ models, userId: 42, filter: "anteriores", now });

    const options = models.Appointment.findAll.mock.calls[0][0];
    expect(options.where.patientId).toBe(7);
    expect(options.where.startsAt[Op.lt]).toEqual(now);
    expect(options.order).toEqual([["startsAt", "DESC"]]);
  });

  test("returns all dates without a date condition", async () => {
    const models = modelsFor();

    const result = await getPatientAppointments({ models, userId: 42, filter: "todas", now });

    expect(result.filter).toBe("todas");
    expect(models.Appointment.findAll.mock.calls[0][0].where).toEqual({ patientId: 7 });
  });

  test("formats appointment information in Spanish and enables changes at least 24 hours ahead", () => {
    const appointment = presentAppointment({
      id: 3,
      startsAt: new Date(now.getTime() + 24 * 60 * 60 * 1000),
      endsAt: new Date(now.getTime() + 25 * 60 * 60 * 1000),
      status: "CONFIRMED",
      doctor: { user: { firstName: "Ana", lastName: "Pérez" } },
      specialty: { name: "Medicina general" }
    }, now);

    expect(appointment.doctorName).toBe("Ana Pérez");
    expect(appointment.specialtyName).toBe("Medicina general");
    expect(appointment.status).toBe("Confirmada");
    expect(appointment.canCancel).toBe(true);
    expect(appointment.canReschedule).toBe(true);
    expect(appointment.date.toLowerCase()).toContain("17");
  });

  test("does not enable changes for completed, cancelled, or soon appointments", () => {
    const soon = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const base = { startsAt: soon, endsAt: soon, doctor: {}, specialty: {} };

    expect(presentAppointment({ ...base, status: "CONFIRMED" }, now).canCancel).toBe(false);
    expect(presentAppointment({ ...base, status: "ATTENDED" }, now).canReschedule).toBe(false);
    expect(presentAppointment({ ...base, status: "CANCELLED" }, now).canCancel).toBe(false);
  });

  test("rejects unknown filters without querying appointments", async () => {
    const models = modelsFor();

    const result = await getPatientAppointments({ models, userId: 42, filter: "incorrecto", now });

    expect(result.status).toBe("invalid");
    expect(models.Appointment.findAll).not.toHaveBeenCalled();
  });

  test("history returns only appointment details and never clinical information", async () => {
    const models = modelsFor([{
      id: 9,
      startsAt: new Date("2026-11-10T14:00:00.000Z"),
      endsAt: new Date("2026-11-10T14:30:00.000Z"),
      status: "ATTENDED",
      diagnosis: "Información clínica privada",
      prescription: "Información clínica privada",
      doctor: { user: { firstName: "Ana", lastName: "Pérez" } },
      specialty: { name: "Medicina general" }
    }]);

    const result = await getPatientAppointments({
      models, userId: 42, filter: "anteriores", now
    });

    expect(result.status).toBe("ready");
    expect(result.appointments).toHaveLength(1);
    expect(result.appointments[0]).toMatchObject({
      id: 9,
      doctorName: "Ana Pérez",
      specialtyName: "Medicina general",
      status: "Atendida"
    });
    expect(result.appointments[0]).not.toHaveProperty("diagnosis");
    expect(result.appointments[0]).not.toHaveProperty("prescription");
    expect(models.Appointment.findAll.mock.calls[0][0].where.patientId).toBe(7);
  });

  test("does not expose appointments when no patient profile belongs to the user", async () => {
    const models = modelsFor();
    models.Patient.findOne.mockResolvedValue(null);

    const result = await getPatientAppointments({ models, userId: 404, now });

    expect(result.status).toBe("not_found");
    expect(models.Appointment.findAll).not.toHaveBeenCalled();
  });
});
