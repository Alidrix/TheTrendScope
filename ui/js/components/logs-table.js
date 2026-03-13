import { formatDate, textCell } from '../utils.js';
import { statusBadge } from './status-chip.js';

export function logRow(log) {
  return `<tr><td>${textCell(formatDate(log.created_at), 'text-ellipsis')}</td><td>${textCell(log.scope || '', 'text-ellipsis')}</td><td>${statusBadge(log.level)}</td><td>${textCell(log.batch_uuid || '')}</td><td>${textCell(log.email || '')}</td><td>${textCell(log.message || '')}</td></tr>`;
}
