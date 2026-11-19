import type { DriverDay } from '../../api';
import { formatPhone } from '../../../shared/phone';
import './drivers-print-report.css';

export type PrintableDriver = Pick<DriverDay, 'id' | 'name' | 'phone' | 'capacity' | 'order'>;

export default function DriversPrintReport({ drivers, preparedDate }: { drivers: PrintableDriver[]; preparedDate: string }) {
  return <article className="drivers-print-report" lang="ka" aria-label="ყველა მძღოლის დასაბეჭდი სია">
    <header className="drivers-print-heading">
      <div><div className="drivers-print-brand"><span>Green</span>Taxi</div><h1>მძღოლების სრული სია</h1></div>
      <p>მომზადებულია: <strong>{preparedDate.split('-').reverse().join('/')}</strong></p>
    </header>
    <div className="drivers-print-summary"><span>სულ მძღოლები: <strong>{drivers.length}</strong></span><span>მუდმივი რიგის მიხედვით</span></div>
    <table className="drivers-print-table" aria-label="ყველა მძღოლი მუდმივი რიგით">
      <colgroup><col className="drivers-print-col-order" /><col className="drivers-print-col-name" /><col className="drivers-print-col-phone" /><col className="drivers-print-col-capacity" /></colgroup>
      <thead><tr><th scope="col" className="drivers-print-order">რიგი</th><th scope="col">მძღოლი</th><th scope="col">ტელეფონის ნომერი</th><th scope="col" className="drivers-print-capacity">ადგილები</th></tr></thead>
      <tbody>{drivers.map((driver, index) => <tr key={driver.id} data-print-driver-id={driver.id}>
        <td className="drivers-print-order">{index + 1}</td><td>{driver.name}</td><td className="drivers-print-phone">{driver.phone ? formatPhone(driver.phone) : '—'}</td><td className="drivers-print-capacity">{driver.capacity}</td>
      </tr>)}</tbody>
    </table>
  </article>;
}
