import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarCheck, Search } from 'lucide-react';
import { usePageTitle } from '@/hooks/usePageTitle';

// Public entry point. Booking pages belong to individual businesses, so customers arrive
// via a business-specific link (/book/:slug). This page only offers booking lookup by reference.
export default function BookingLanding() {
  usePageTitle('Book an appointment');
  const navigate = useNavigate();
  const [ref, setRef] = useState('');

  const cleanRef = ref.trim().toUpperCase();

  function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!cleanRef) return;
    navigate(`/book/lookup/manage?ref=${encodeURIComponent(cleanRef)}`);
  }

  return (
    <div className="max-w-lg mx-auto px-4 pt-10 pb-12">
      <div className="text-center mb-10">
        <div className="w-14 h-14 rounded-2xl bg-primary-light flex items-center justify-center mx-auto mb-4">
          <CalendarCheck className="w-7 h-7 text-primary" />
        </div>
        <h1 className="text-2xl font-bold text-text-primary mb-2">Book an Appointment</h1>
        <p className="text-text-secondary">
          To make a new booking, use the booking link shared by the business you want to visit.
        </p>
      </div>

      <form onSubmit={handleLookup} className="bg-surface rounded-xl border border-border shadow-card p-5">
        <label htmlFor="booking-ref" className="block text-sm font-semibold text-text-primary mb-1">
          Already booked?
        </label>
        <p className="text-xs text-text-muted mb-3">
          Enter the reference from your confirmation (for example <span className="font-mono">WE-ABC12345</span>) to view, reschedule or cancel it. You will also need the email address you booked with.
        </p>
        <div className="flex gap-2">
          <input
            id="booking-ref"
            value={ref}
            onChange={e => setRef(e.target.value)}
            placeholder="WE-XXXXXXXX"
            className="input-field flex-1 font-mono uppercase"
            autoComplete="off"
          />
          <button
            type="submit"
            disabled={!cleanRef}
            className="inline-flex items-center gap-1.5 px-4 rounded-lg bg-primary text-white text-sm font-semibold disabled:opacity-50"
          >
            <Search className="w-4 h-4" />
            Find
          </button>
        </div>
      </form>
    </div>
  );
}
