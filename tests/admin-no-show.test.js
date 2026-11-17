const path = require("node:path");
const pug = require("pug");
const { getNoShowPreview, markAppointmentNoShow } = require("../src/modules/admin/services/no-show");
const { createAdminRouter } = require("../src/modules/admin/routes");

const now = new Date("2026-11-19T12:00:00.000Z");

function harness({ status = "CONFIRMED", endsAt = "2026-11-18T15:00:00.000Z" } = {}) {
  const appointment = {
    id: 31, status, startsAt: new Date("2026-11-18T14:30:00.000Z"),
    endsAt: new Date(endsAt),
    patient: { user: { firstName: "Laura", lastName: "Paz" } },
    doctor: { user: { firstName: "Carlos", lastName: "Méndez" } },
    specialty: { name: "Medicina general" },
    update: jest.fn()
  };
  const models = {
    Appointment: { findByPk: jest.fn().mockResolvedValue(appointment) },
    Patient: {}, Doctor: {}, Specialty: {},
    User: {}, AuditLog: { create: jest.fn().mockResolvedValue({}) }
  };
  const transaction = { LOCK: { UPDATE: "UPDATE" } };
  const sequelize = { transaction: jest.fn((callback) => callback(transaction)) };
  return { appointment, models, sequelize, transaction };
}

describe("administrator no-show registration", () => {
  test("compiles the confirmation screen", () => {
    expect(() => pug.compileFile(path.join(__dirname, "../src/modules/admin/views/no-show-confirmation.pug"))).not.toThrow();
  });

  test("allows confirmation only after a confirmed appointment has ended", async () => {
    const finished = harness();
    expect(await getNoShowPreview({ models: finished.models, appointmentId: "31", now }))
      .toMatchObject({ status: "ready", appointment: { patientName: "Laura Paz" } });

    const upcoming = harness({ endsAt: "2026-11-19T12:01:00.000Z" });
    expect((await getNoShowPreview({ models: upcoming.models, appointmentId: "31", now })).status)
      .toBe("not_finished");

    const cancelled = harness({ status: "CANCELLED" });
    expect((await getNoShowPreview({ models: cancelled.models, appointmentId: "31", now })).status)
      .toBe("not_confirmed");
  });

  test("records no-show status and audit actor and time in one transaction", async () => {
    const { appointment, models, sequelize, transaction } = harness();
    const result = await markAppointmentNoShow({
      sequelize, models, actorUserId: 5, appointmentId: "31", confirmed: "YES", now
    });
    expect(result).toMatchObject({ status: "marked", markedAt: now });
    expect(appointment.update).toHaveBeenCalledWith({ status: "NO_SHOW", updatedAt: now }, { transaction });
    expect(models.AuditLog.create).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 5, action: "ADMIN_APPOINTMENT_MARKED_NO_SHOW",
      beforeData: expect.objectContaining({ status: "CONFIRMED" }),
      afterData: { status: "NO_SHOW", markedAt: now }, createdAt: now
    }), { transaction });
  });

  test("does not change the appointment before explicit confirmation or before it ends", async () => {
    const notConfirmed = harness();
    expect((await markAppointmentNoShow({
      ...notConfirmed, actorUserId: 5, appointmentId: "31", confirmed: "NO", now
    })).status).toBe("confirmation_required");
    expect(notConfirmed.sequelize.transaction).not.toHaveBeenCalled();

    const upcoming = harness({ endsAt: "2026-11-19T12:01:00.000Z" });
    expect((await markAppointmentNoShow({
      ...upcoming, actorUserId: 5, appointmentId: "31", confirmed: "YES", now
    })).status).toBe("not_finished");
    expect(upcoming.appointment.update).not.toHaveBeenCalled();
  });

  test("requires an administrator for no-show registration", () => {
    const router = createAdminRouter({ models: { User: { findByPk: jest.fn() } } });
    const route = router.stack.find((layer) => layer.route?.path === "/administrador/citas/:appointmentId/inasistencia");
    expect(route).toBeDefined();
    const requireAdminRole = route.route.stack[1].handle;
    const response = { status: jest.fn().mockReturnThis(), render: jest.fn() };
    requireAdminRole({ currentUser: { role: "DOCTOR" } }, response, () => {
      throw new Error("Un médico no debe continuar.");
    });
    expect(response.status).toHaveBeenCalledWith(403);
  });
});
