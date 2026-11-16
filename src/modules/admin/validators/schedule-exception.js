const TIME_ZONE_OFFSET_MINUTES = 5 * 60;

function parseLocalDateTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) return null;
  const [, y, mo, d, h, mi] = match.map(Number);
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi));
  if (local.getUTCFullYear() !== y || local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d
    || local.getUTCHours() !== h || local.getUTCMinutes() !== mi) return null;
  return new Date(local.getTime() + TIME_ZONE_OFFSET_MINUTES * 60_000);
}

function validateScheduleException(input = {}) {
  const values = {
    startsAt: String(input.startsAt || "").trim(),
    endsAt: String(input.endsAt || "").trim(),
    reason: String(input.reason || "").trim()
  };
  const errors = {};
  const startsAt = parseLocalDateTime(values.startsAt);
  const endsAt = parseLocalDateTime(values.endsAt);
  if (!startsAt) errors.startsAt = "Ingresa una fecha y hora de inicio válidas.";
  if (!endsAt) errors.endsAt = "Ingresa una fecha y hora de fin válidas.";
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) {
    errors.endsAt = "La fecha y hora de fin deben ser posteriores al inicio.";
  }
  if (!values.reason) errors.reason = "Escribe el motivo del bloqueo.";
  else if (values.reason.length > 255) errors.reason = "El motivo no puede superar 255 caracteres.";
  return {
    values,
    errors,
    isValid: Object.keys(errors).length === 0,
    data: startsAt && endsAt ? { startsAt, endsAt, reason: values.reason } : null
  };
}

module.exports = { parseLocalDateTime, validateScheduleException };
