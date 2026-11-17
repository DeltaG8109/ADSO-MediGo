const { Op } = require("sequelize");
const { getAdminAppointments, presentAppointment, validDate } = require("../src/modules/admin/services/appointments");

describe("administrator appointment search", () => {
  function appointmentModels(rows = []) {
    return {
      Patient: {}, Doctor: {}, User: {},
      Specialty: { findAll: jest.fn().mockResolvedValue([{ id: 4, name: "Medicina general" }]) },
      Appointment: { findAndCountAll: jest.fn().mockResolvedValue({ count: rows.length, rows }) }
    };
  }

  test("searches by patient or doctor and filters date, status, and specialty", async () => {
    const models = appointmentModels();
    const result = await getAdminAppointments({
      models, search: "  Ana  ", date: "2026-11-17",
      status: "ATTENDED", specialtyId: "4", page: "2"
    });
    const query = models.Appointment.findAndCountAll.mock.calls[0][0];

    expect(result).toMatchObject({
      status: "ready", search: "Ana", selectedDate: "2026-11-17",
      selectedStatus: "ATTENDED", selectedSpecialty: "4", page: 2
    });
    expect(query.where.status).toBe("ATTENDED");
    expect(query.where.specialtyId).toBe("4");
    expect(query.where.startsAt[Op.gte]).toEqual(new Date("2026-11-17T05:00:00.000Z"));
    expect(query.where.startsAt[Op.lt]).toEqual(new Date("2026-11-18T05:00:00.000Z"));
    expect(query.where[Op.or]).toHaveLength(5);
    expect(query.offset).toBe(20);
    expect(query.limit).toBe(20);
    expect(query.attributes).not.toContain("clinicalNotes");
  });

  test("shows administrative details in Spanish and leaves clinical data out", () => {
    const appointment = presentAppointment({
      id: 12, status: "ATTENDED",
      startsAt: new Date("2026-11-17T15:30:00.000Z"),
      diagnosis: "privado",
      clinicalNotes: "privado",
      patient: { user: { firstName: "Ana", lastName: "Paz", documentType: "CC", documentNumber: "123" } },
      doctor: { user: { firstName: "Luis", lastName: "Díaz" } },
      specialty: { name: "Medicina general" }
    });
    expect(appointment).toMatchObject({
      patientName: "Ana Paz", patientDocument: "CC 123",
      doctorName: "Luis Díaz", specialtyName: "Medicina general", status: "Atendida"
    });
    expect(appointment).not.toHaveProperty("diagnosis");
    expect(appointment).not.toHaveProperty("clinicalNotes");
  });

  test("rejects invalid dates and filters before querying", async () => {
    const models = appointmentModels();
    expect(validDate("2026-02-30")).toBe(false);
    expect((await getAdminAppointments({ models, date: "2026-02-30" })).status).toBe("invalid_date");
    expect((await getAdminAppointments({ models, status: "UNKNOWN" })).status).toBe("invalid");
    expect(models.Appointment.findAndCountAll).not.toHaveBeenCalled();
  });

  test("presents an empty result when the filters find no appointments", async () => {
    const result = await getAdminAppointments({ models: appointmentModels() });
    expect(result).toMatchObject({ status: "ready", total: 0, pageCount: 1, appointments: [] });
  });
});
