'use strict';
// Datos de las plantillas iniciales de checklist: tareas típicas de
// hostelería, con dos de temperatura de cámaras (0–5 °C) en las de cocina.
// Compartido entre backend/scripts/checklists-plantillas.js (alta manual
// por consola) y POST /checklists/plantilla (botón "un clic" del panel de
// configuración) — una sola fuente para no divergir.
const PLANTILLAS = [
  {
    nombre: 'Apertura cocina', turno: 'apertura',
    tareas: [
      { titulo: 'Revisar limpieza de la cocina', hora_limite: '11:00' },
      { titulo: 'Temperatura cámara frigorífica 1', hora_limite: '11:00', requiere_valor: true, valor_etiqueta: '°C', valor_min: 0, valor_max: 5 },
      { titulo: 'Temperatura cámara frigorífica 2', hora_limite: '11:00', requiere_valor: true, valor_etiqueta: '°C', valor_min: 0, valor_max: 5 },
      { titulo: 'Revisar stock de materia prima del día', hora_limite: '11:00' },
      { titulo: 'Foto de la cocina lista para abrir', hora_limite: '11:30', requiere_foto: true },
    ],
  },
  {
    nombre: 'Cierre cocina', turno: 'cierre',
    tareas: [
      { titulo: 'Limpieza de superficies y utensilios', hora_limite: '23:30', requiere_foto: true },
      { titulo: 'Apagar equipos que no sean necesarios de noche', hora_limite: '23:45' },
      { titulo: 'Sacar la basura', hora_limite: '23:45' },
      { titulo: 'Foto de la cocina cerrada', hora_limite: '23:45', requiere_foto: true },
    ],
  },
  {
    nombre: 'Apertura sala', turno: 'apertura',
    tareas: [
      { titulo: 'Montaje de mesas y sillas', hora_limite: '11:30' },
      { titulo: 'Encender terraza y luces', hora_limite: '11:30' },
      { titulo: 'Foto del comedor listo', hora_limite: '11:45', requiere_foto: true },
    ],
  },
  {
    nombre: 'Cierre sala', turno: 'cierre',
    tareas: [
      { titulo: 'Recoger y limpiar mesas', hora_limite: '23:45' },
      { titulo: 'Cerrar caja registradora', hora_limite: '23:45' },
      { titulo: 'Foto del comedor cerrado', hora_limite: '23:59', requiere_foto: true },
    ],
  },
];

module.exports = { PLANTILLAS };
