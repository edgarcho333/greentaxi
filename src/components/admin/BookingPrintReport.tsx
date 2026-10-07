import { directions, type Booking, type Direction, type Stop } from '../../api';
import { formatPhone } from '../../../shared/phone';
import './booking-print-report.css';

type BookingPrintReportProps = {
  bookings: Booking[];
  date: string;
  direction: Direction | 'both';
  time: string | null;
  stops?: Stop[];
};

function reportDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : date;
}

function PickupAddress({ booking, stops }: { booking: Booking; stops: Stop[] }) {
  const stopAddress = booking.direction === 'tbilisi-gori' ? stops.find(stop => stop.id === booking.pickupStopId)?.address : null;
  const address = booking.direction === 'gori-tbilisi' ? booking.goriAddress
    : [booking.pickupStopName || 'პუნქტი არ არის მითითებული', stopAddress].filter(Boolean).join(' · ');
  return <div className="booking-print-address">{address}</div>;
}

export default function BookingPrintReport({ bookings, date, direction, time, stops = [] }: BookingPrintReportProps) {
  const rows = [...bookings].sort((first, second) => {
    const timeOrder = (first.assignedTime ?? first.requestedTime).localeCompare(second.assignedTime ?? second.requestedTime);
    if (timeOrder) return timeOrder;
    return first.direction.localeCompare(second.direction) || first.id - second.id;
  });
  const seatTotal = rows.reduce((sum, booking) => sum + booking.seats, 0);

  return <article className="booking-print-report" lang="ka" aria-label="ჯავშნების დასაბეჭდი სია">
    <header className="booking-print-heading">
      <div><div className="booking-print-brand"><span>Green</span>Taxi</div><h1>ჯავშნების სია</h1></div>
      <dl className="booking-print-details">
        <div><dt>თარიღი</dt><dd>{reportDate(date)}</dd></div>
        <div><dt>მიმართულება</dt><dd>{direction === 'both' ? 'ორივე მიმართულება' : directions[direction]}</dd></div>
        <div><dt>გასვლის დრო</dt><dd>{time ?? 'ყველა დრო'}</dd></div>
      </dl>
    </header>

    <div className="booking-print-summary"><span>სულ ჯავშნები: <strong>{rows.length}</strong></span><span>სულ ადგილები: <strong>{seatTotal}</strong></span></div>

    <table className="booking-print-table" aria-label="მგზავრებისა და მისამართების სია">
      <colgroup><col className="booking-print-col-number" /><col className="booking-print-col-time" /><col className="booking-print-col-name" /><col className="booking-print-col-phone" /><col className="booking-print-col-direction" /><col className="booking-print-col-seats" /><col className="booking-print-col-address" /></colgroup>
      <thead><tr><th scope="col">№</th><th scope="col">დრო</th><th scope="col">მგზავრი</th><th scope="col">ტელეფონი</th><th scope="col">მიმართულება</th><th scope="col">ადგილები</th><th scope="col">ჩასხდომის მისამართი</th></tr></thead>
      <tbody>
        {rows.map((booking, index) => <tr key={booking.id}>
          <td className="booking-print-number">{index + 1}</td>
          <td className="booking-print-time">{booking.assignedTime ?? booking.requestedTime}</td>
          <td className="booking-print-passenger">{booking.name}</td>
          <td className="booking-print-phone">{formatPhone(booking.phone)}</td>
          <td className="booking-print-direction">{directions[booking.direction]}</td>
          <td className="booking-print-seats">{booking.seats}</td>
          <td><PickupAddress booking={booking} stops={stops} /></td>
        </tr>)}
        {rows.length === 0 && <tr><td colSpan={7} className="booking-print-empty">არჩეულ თარიღსა და დროზე ჯავშნები არ არის.</td></tr>}
      </tbody>
    </table>
    <footer className="booking-print-footer"><span>{reportDate(date)} · {direction === 'both' ? 'ორივე მიმართულება' : directions[direction]} · {time ?? 'ყველა დრო'}</span><span>{rows.length} ჯავშანი · {seatTotal} ადგილი</span></footer>
  </article>;
}
