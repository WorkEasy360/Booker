import React, { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Users, Plus, Search, Phone, Mail, ChevronLeft, ChevronRight, UserPlus, X } from 'lucide-react';
import { PageTitle, Avatar, Spinner } from '@/components/ui';
import { customersApi } from '@/api/client';
import { useAuth } from '@/contexts/AuthContext';
import { usePageTitle } from '@/hooks/usePageTitle';
import { cn, formatDate } from '@/lib/utils';
import { normalizeCustomer, type CustomerRecord } from './customerData';

const PAGE_SIZE = 10;
const digits = (s: string) => s.replace(/\D/g, '');

export default function CustomersPage() {
  usePageTitle('Customers');
  const navigate = useNavigate();
  const { can } = useAuth();
  const canWrite = can('customers:write');

  const [customers, setCustomers] = useState<CustomerRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    customersApi.list()
      .then(rows => setCustomers(rows.map(normalizeCustomer)))
      .catch((e: Error) => { setError(e.message || 'Could not load customers.'); setCustomers([]); });
  }, []);

  const filtered = useMemo(() => {
    const list = customers ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return list;
    const qd = digits(q);
    return list.filter(c =>
      c.name.toLowerCase().includes(q)
      || (c.email?.toLowerCase().includes(q) ?? false)
      || (qd.length >= 3 && !!c.phone && digits(c.phone).includes(qd)),
    );
  }, [customers, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, totalPages);
  const paged = filtered.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE);
  const from = filtered.length ? (current - 1) * PAGE_SIZE + 1 : 0;
  const to = Math.min(current * PAGE_SIZE, filtered.length);

  return (
    <div className="page-container space-y-6">
      <PageTitle
        icon={Users}
        title="Customers"
        description="Find customers, see their appointment history and book again."
        actions={canWrite ? (
          <Link to="/customers/new" className="btn-primary min-h-[48px] px-5 text-base">
            <Plus className="w-5 h-5" aria-hidden="true" />Add Customer
          </Link>
        ) : undefined}
      />

      <section className="panel" aria-label="Customer list">
        {/* Search */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-4 sm:p-5">
          <div className="relative w-full sm:max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-text-muted" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search customers by name, phone or email"
              placeholder="Search by name, phone or email"
              value={search}
              onChange={e => { setSearch(e.target.value); setPage(1); }}
              className="w-full h-12 rounded-xl border border-border bg-white pl-11 pr-4 text-[15px] placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary"
            />
          </div>
          {customers && customers.length > 0 && (
            <p className="text-sm text-text-secondary">{customers.length} customer{customers.length === 1 ? '' : 's'}</p>
          )}
        </div>

        {error && <p role="alert" className="mx-4 sm:mx-5 mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

        {customers === null ? (
          <div className="flex justify-center py-16"><Spinner /></div>
        ) : customers.length === 0 && !error ? (
          <div className="px-6 py-14 text-center border-t border-border">
            <span className="icon-tile w-14 h-14 bg-primary-light text-primary mb-3"><UserPlus className="w-7 h-7" aria-hidden="true" /></span>
            <p className="text-lg font-semibold text-text-primary">No customers yet</p>
            <p className="text-sm text-text-secondary mt-1">Customers are added when they book online, or you can add one now.</p>
            {canWrite && <Link to="/customers/new" className="btn-primary mt-5 min-h-[44px]"><Plus className="w-4 h-4" aria-hidden="true" />Add First Customer</Link>}
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-6 py-14 text-center border-t border-border">
            <p className="text-lg font-semibold text-text-primary">No customers match “{search}”</p>
            <p className="text-sm text-text-secondary mt-1">Try a different name, phone number or email.</p>
            <button type="button" className="btn-secondary mt-5 min-h-[44px]" onClick={() => { setSearch(''); setPage(1); }}>
              <X className="w-4 h-4" aria-hidden="true" />Clear Search
            </button>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden md:block px-4 sm:px-5">
              <table className="w-full text-[15px]">
                <thead>
                  <tr className="bg-[#F3F5F8] text-left text-text-primary">
                    <th scope="col" className="rounded-l-lg px-4 py-3.5 font-semibold">Customer</th>
                    <th scope="col" className="px-4 py-3.5 font-semibold">Phone</th>
                    <th scope="col" className="px-4 py-3.5 font-semibold">Email</th>
                    <th scope="col" className="px-4 py-3.5 font-semibold text-right">Bookings</th>
                    <th scope="col" className="rounded-r-lg px-4 py-3.5 font-semibold">Last Booking</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {paged.map(c => (
                    <tr key={c.id} onClick={() => navigate(`/customers/${c.id}`)} className="cursor-pointer hover:bg-gray-50/80 transition-colors">
                      <td className="px-4 py-4">
                        <Link to={`/customers/${c.id}`} onClick={e => e.stopPropagation()} className="flex items-center gap-3 min-w-0 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded">
                          <Avatar name={c.name} size="md" color="#16A34A" decorative />
                          <span className="font-semibold text-text-primary truncate">{c.name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-4 text-text-secondary whitespace-nowrap">{c.phone ?? <span className="text-text-muted">—</span>}</td>
                      <td className="px-4 py-4 text-text-secondary max-w-[16rem] truncate">{c.email ?? <span className="text-text-muted">—</span>}</td>
                      <td className="px-4 py-4 text-right text-text-primary">{c.totalBookings ?? 0}</td>
                      <td className="px-4 py-4 text-text-secondary whitespace-nowrap">{c.lastBookingDate ? formatDate(c.lastBookingDate, 'd MMM yyyy') : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <ul className="md:hidden divide-y divide-border border-t border-border">
              {paged.map(c => (
                <li key={c.id}>
                  <Link to={`/customers/${c.id}`} className="flex items-center gap-3 px-4 py-4 min-h-[64px] active:bg-gray-50">
                    <Avatar name={c.name} size="lg" color="#16A34A" decorative />
                    <div className="min-w-0 flex-1">
                      <p className="text-base font-semibold text-text-primary truncate">{c.name}</p>
                      {c.phone && <p className="flex items-center gap-1.5 text-sm text-text-secondary truncate"><Phone className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />{c.phone}</p>}
                      {c.email && <p className="flex items-center gap-1.5 text-sm text-text-secondary truncate"><Mail className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />{c.email}</p>}
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-medium text-text-primary">{c.totalBookings ?? 0}</p>
                      <p className="text-xs text-text-muted">bookings</p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>

            {/* Pagination */}
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 sm:px-6 py-5">
              <p className="text-[15px] text-text-secondary">Showing {from} – {to} of {filtered.length} customers</p>
              {totalPages > 1 && (
                <nav aria-label="Pages" className="flex items-center gap-2">
                  <button type="button" aria-label="Previous page" disabled={current === 1} onClick={() => setPage(current - 1)}
                    className="w-10 h-10 inline-flex items-center justify-center rounded-lg border border-border bg-white text-text-primary disabled:opacity-40">
                    <ChevronLeft className="w-5 h-5" aria-hidden="true" />
                  </button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1)
                    .filter(n => n === 1 || n === totalPages || Math.abs(n - current) <= 1)
                    .map((n, i, arr) => (
                      <React.Fragment key={n}>
                        {i > 0 && n - arr[i - 1] > 1 && <span className="px-1 text-text-muted">…</span>}
                        <button type="button" aria-current={n === current ? 'page' : undefined} onClick={() => setPage(n)}
                          className={cn('min-w-10 h-10 px-3 rounded-lg text-[15px] font-medium', n === current ? 'bg-brand-active text-white' : 'text-text-primary hover:bg-gray-100')}>
                          {n}
                        </button>
                      </React.Fragment>
                    ))}
                  <button type="button" aria-label="Next page" disabled={current === totalPages} onClick={() => setPage(current + 1)}
                    className="w-10 h-10 inline-flex items-center justify-center rounded-lg border border-border bg-white text-text-primary disabled:opacity-40">
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                </nav>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}
