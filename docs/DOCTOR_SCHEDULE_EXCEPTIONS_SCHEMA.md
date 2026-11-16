# Diseño físico de excepciones de agenda

Este esquema implementa US-ADM-07 con intervalos puntuales. Los extremos se interpretan como un intervalo semiabierto: incluye el inicio y excluye el final. Así, una cita que termina exactamente cuando comienza el bloqueo no se considera afectada.

## `doctor_schedule_exceptions`

| Columna | Tipo MySQL | Reglas |
|---|---|---|
| `id` | `BIGINT UNSIGNED` | PK, autoincremental |
| `doctor_id` | `BIGINT UNSIGNED` | Obligatorio, FK a `doctors.id` |
| `starts_at` | `DATETIME(3)` | Inicio del intervalo, almacenado en UTC |
| `ends_at` | `DATETIME(3)` | Fin del intervalo, almacenado en UTC y posterior al inicio |
| `reason` | `VARCHAR(255)` | Motivo obligatorio |
| `status` | `ENUM('ACTIVE','INACTIVE')` | Estado de la excepción; las filas históricas se conservan |
| `created_at` | `DATETIME(3)` | Obligatorio |
| `updated_at` | `DATETIME(3)` | Obligatorio |

Índice de consulta: `(doctor_id, status, starts_at, ends_at)`.

## Fechas, citas y auditoría

La pantalla recibe fechas y horas locales de `America/Bogota` y las convierte a UTC antes de guardarlas. Las citas confirmadas futuras se consideran afectadas cuando sus intervalos se cruzan con el bloqueo. Antes de guardar, se muestra la lista; al confirmar, se recalcula dentro de una transacción, se crea la excepción, se cancelan las citas afectadas y se registran los cambios en `audit_logs`. Después del commit se envían notificaciones por correo. Si cambió la lista de citas, se solicita confirmarla de nuevo.
