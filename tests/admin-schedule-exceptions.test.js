const path = require("node:path");
const pug = require("pug");
const { parseLocalDateTime, validateScheduleException } = require("../src/modules/admin/validators/schedule-exception");
const {
  previewScheduleException, saveScheduleException, overlaps
} = require("../src/modules/admin/services/schedule-exceptions");

function transactionHarness() {
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  return { transaction, sequelize: { transaction: (callback) => callback(transaction) } };
}

function appointment(id, startsAt, endsAt) {
  return {
    id, startsAt: new Date(startsAt), endsAt: new Date(endsAt), status: "CONFIRMED",
    cancelledAt: null, cancellationReason: null,
    patient: { user: { firstName: "Laura", lastName: "Gómez", email: "laura@example.com" } },
    save: jest.fn().mockResolvedValue(undefined)
  };
}

describe("administrator schedule exceptions", () => {
  test("compiles the exception screens", () => {
    for (const view of ["schedule-exceptions.pug", "schedule-exception-confirmation.pug"]) {
      expect(() => pug.compileFile(path.join(__dirname, "../src/modules/admin/views", view))).not.toThrow();
    }
  });

  test("converts Colombia local time to UTC and rejects impossible dates", () => {
    expect(parseLocalDateTime("2026-11-16T09:00").toISOString()).toBe("2026-11-16T14:00:00.000Z");
    expect(parseLocalDateTime("2026-02-30T09:00")).toBeNull();
  });

  test("validates interval order and required reason", () => {
    const valid = validateScheduleException({
      startsAt: "2026-11-16T09:00", endsAt: "2026-11-16T10:00", reason: "Mantenimiento"
    });
    expect(valid.isValid).toBe(true);
    expect(valid.data.startsAt.toISOString()).toBe("2026-11-16T14:00:00.000Z");

    const invalid = validateScheduleException({
      startsAt: "2026-11-16T10:00", endsAt: "2026-11-16T09:00", reason: ""
    });
    expect(invalid.isValid).toBe(false);
    expect(invalid.errors.endsAt).toMatch(/posteriores/);
    expect(invalid.errors.reason).toMatch(/motivo/);
  });

  test("uses half-open overlap rules so adjacent appointments stay unaffected", () => {
    const interval = { startsAt: new Date("2026-11-16T14:30:00Z"), endsAt: new Date("2026-11-16T15:30:00Z") };
    expect(overlaps(appointment(1, "2026-11-16T14:00:00Z", "2026-11-16T14:30:00Z"), interval)).toBe(false);
    expect(overlaps(appointment(2, "2026-11-16T14:15:00Z", "2026-11-16T14:45:00Z"), interval)).toBe(true);
  });

  test("previews only future confirmed appointments that overlap", async () => {
    const adjacent = appointment(1, "2026-11-16T14:00:00Z", "2026-11-16T14:30:00Z");
    const affected = appointment(2, "2026-11-16T14:15:00Z", "2026-11-16T14:45:00Z");
    const result = await previewScheduleException({
      models: {
        Doctor: { findByPk: jest.fn().mockResolvedValue({ id: 5 }) },
        Appointment: { findAll: jest.fn().mockResolvedValue([adjacent, affected]) },
        Patient: {}, User: {}
      },
      doctorId: "5", startsAt: new Date("2026-11-16T14:30:00Z"),
      endsAt: new Date("2026-11-16T15:00:00Z"), now: new Date("2026-11-15T12:00:00Z")
    });
    expect(result.status).toBe("ready");
    expect(result.appointments.map((row) => row.id)).toEqual([2]);
  });

  test("recalculates the preview before saving and cancelling appointments", async () => {
    const { sequelize, transaction } = transactionHarness();
    const affected = appointment(2, "2026-11-16T14:15:00Z", "2026-11-16T14:45:00Z");
    const createException = jest.fn().mockResolvedValue({ id: 12 });
    const audit = jest.fn().mockResolvedValue({});
    const sendNotice = jest.fn().mockResolvedValue(undefined);
    const result = await saveScheduleException({
      sequelize,
      models: {
        Doctor: { findByPk: jest.fn().mockResolvedValue({ id: 5 }) },
        DoctorScheduleException: { create: createException },
        Appointment: { findAll: jest.fn().mockResolvedValue([affected]) },
        AuditLog: { create: audit }, Patient: {}, User: {}
      },
      doctorId: "5", actorUserId: 9,
      startsAt: new Date("2026-11-16T14:00:00Z"), endsAt: new Date("2026-11-16T15:00:00Z"),
      reason: "Mantenimiento", confirmed: "YES", confirmedAppointmentIds: ["2"],
      emailSender: { sendAppointmentCancellationNotification: sendNotice },
      now: new Date("2026-11-15T12:00:00Z")
    });
    expect(result).toMatchObject({ status: "saved", exceptionId: 12, cancelled: 1, failedNotifications: 0 });
    expect(createException).toHaveBeenCalledWith(expect.objectContaining({
      doctorId: 5, reason: "Mantenimiento", status: "ACTIVE"
    }), { transaction });
    expect(affected).toMatchObject({ status: "CANCELLED", cancellationReason: "Bloqueo de agenda médica" });
    expect(affected.save).toHaveBeenCalledWith({ transaction });
    expect(audit).toHaveBeenCalledTimes(2);
    expect(sendNotice).toHaveBeenCalledWith(expect.objectContaining({
      to: "laura@example.com", appointmentDate: expect.any(String), appointmentTime: expect.any(String)
    }));
  });

  test("requires a new confirmation when the affected appointment list changes", async () => {
    const { sequelize } = transactionHarness();
    const affected = appointment(2, "2026-11-16T14:15:00Z", "2026-11-16T14:45:00Z");
    const createException = jest.fn();
    const result = await saveScheduleException({
      sequelize,
      models: {
        Doctor: { findByPk: jest.fn().mockResolvedValue({ id: 5 }) },
        DoctorScheduleException: { create: createException },
        Appointment: { findAll: jest.fn().mockResolvedValue([affected]) },
        AuditLog: { create: jest.fn() }, Patient: {}, User: {}
      },
      doctorId: "5", actorUserId: 9,
      startsAt: new Date("2026-11-16T14:00:00Z"), endsAt: new Date("2026-11-16T15:00:00Z"),
      reason: "Mantenimiento", confirmed: "YES", confirmedAppointmentIds: [],
      now: new Date("2026-11-15T12:00:00Z")
    });
    expect(result.status).toBe("preview_changed");
    expect(createException).not.toHaveBeenCalled();
    expect(affected.save).not.toHaveBeenCalled();
  });
});
