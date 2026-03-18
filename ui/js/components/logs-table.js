import { formatDate, textCell } from '../utils.js';
import { statusBadge } from './status-chip.js';

export function logRow(log) {
  return `<tr class="logs-row">
    <td class="logs-cell">${textCell(formatDate(log.created_at), 'text-ellipsis')}</td>
    <td class="logs-cell">${textCell(log.scope || '', 'text-ellipsis')}</td>
    <td class="logs-cell">${statusBadge(log.level)}</td>
    <td class="logs-cell">${textCell(log.batch_uuid || '')}</td>
    <td class="logs-cell">${textCell(log.email || '')}</td>
    <td class="logs-cell">${textCell(log.message || '')}</td>
  </tr>`;
}
