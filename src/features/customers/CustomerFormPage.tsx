import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { UserPlus, UserPen, ArrowLeft } from 'lucide-react';
import { PageTitle, Spinner, useToast } from '@/components/ui';
import { customersApi } from '@/api/client';
import { usePageTitle } from '@/hooks/usePageTitle';
import { PHONE_PLACEHOLDER } from '@/lib/validation';
import {
  validateContact, contactBody, conflictFrom, normalizeCustomer,
  type ContactInput, type ContactErrors, type SaveConflict,
} from './customerData';
import { ConflictNotice } from './ConflictNotice';

/** Add a customer (/customers/new) or edit their contact details (/customers/:id/edit). */
export default function CustomerFormPage() {
  const { id } = useParams<{ id: string }>();
  const editing = !!id;
  usePageTitle(editing ? 'Edit Contact Details' : 'Add Customer');
  const navigate = useNavigate();
  const toast = useToast();

  const [values, setValues] = useState<ContactInput>({ name: '', phone: '', email: '' });
  const [errors, setErrors] = useState<ContactErrors>({});
  const [conflict, setConflict] = useState<SaveConflict | null>(null);
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    customersApi.get(id)
      .then(raw => {
        const c = normalizeCustomer(raw);
        setValues({ name: c.name, phone: c.phone ?? '', email: c.email ?? '' });
      })
      .catch((e: Error) => setLoadError(e.message || 'Could not load this customer.'))
      .finally(() => setLoading(false));
  }, [id]);

  function set<K extends keyof ContactInput>(key: K, v: string) {
    setValues(prev => ({ ...prev, [key]: v }));
    setConflict(null);
    setFormError(null);
    if (Object.keys(errors).length) setErrors(validateContact({ ...values, [key]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const found = validateContact(values);
    setErrors(found);
    if (Object.keys(found).length) return;
    setSaving(true);
    setFormError(null);
    setConflict(null);
    try {
      const saved = normalizeCustomer(editing
        ? await customersApi.update(id!, contactBody(values))
        : await customersApi.create(contactBody(values)));
      toast.success(editing ? 'Contact details saved' : 'Customer added', saved.name);
      navigate(`/customers/${saved.id}`, { replace: true });
    } catch (err) {
      const c = await conflictFrom(err, values, id);
      if (c) setConflict(c);
      else setFormError(err instanceof Error ? err.message : 'Could not save. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  const label = 'block text-[15px] font-semibold text-text-primary mb-2';
  const input = 'w-full h-12 rounded-xl border bg-white px-4 text-[15px] placeholder-text-muted focus:outline-none focus:ring-2 focus:ring-primary';
  const border = (bad?: string) => (bad ? 'border-red-400' : 'border-border');

  return (
    <div className="page-container space-y-6 max-w-3xl">
      <Link to={editing ? `/customers/${id}` : '/customers'} className="inline-flex items-center gap-1.5 text-sm font-medium text-text-secondary hover:text-text-primary">
        <ArrowLeft className="w-4 h-4" aria-hidden="true" />{editing ? 'Back to customer' : 'Back to customers'}
      </Link>
      <PageTitle
        icon={editing ? UserPen : UserPlus}
        title={editing ? 'Edit Contact Details' : 'Add Customer'}
        description={editing ? 'Changes apply to this customer’s record; existing appointments are not changed.' : 'Name and at least one way to reach them.'}
      />

      {loading ? (
        <div className="flex justify-center py-16"><Spinner /></div>
      ) : loadError ? (
        <div role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{loadError}</div>
      ) : (
        <form onSubmit={submit} noValidate className="panel p-5 sm:p-7 space-y-5">
          <div>
            <label htmlFor="cust-name" className={label}>Name <span className="text-red-500" aria-hidden="true">*</span></label>
            <input id="cust-name" className={`${input} ${border(errors.name)}`} value={values.name} maxLength={100} autoComplete="off"
              aria-invalid={errors.name ? true : undefined} aria-describedby={errors.name ? 'cust-name-err' : undefined}
              onChange={e => set('name', e.target.value)} placeholder="Customer name" />
            {errors.name && <p id="cust-name-err" className="mt-1.5 text-sm text-red-600">{errors.name}</p>}
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <div>
              <label htmlFor="cust-phone" className={label}>Phone</label>
              <input id="cust-phone" type="tel" inputMode="tel" className={`${input} ${border(errors.phone || errors.contact)}`} value={values.phone}
                aria-invalid={errors.phone ? true : undefined} aria-describedby="cust-contact-hint"
                onChange={e => set('phone', e.target.value)} placeholder={PHONE_PLACEHOLDER} />
              {errors.phone && <p className="mt-1.5 text-sm text-red-600">{errors.phone}</p>}
            </div>
            <div>
              <label htmlFor="cust-email" className={label}>Email</label>
              <input id="cust-email" type="email" inputMode="email" className={`${input} ${border(errors.email || errors.contact)}`} value={values.email}
                aria-invalid={errors.email ? true : undefined} aria-describedby="cust-contact-hint"
                onChange={e => set('email', e.target.value)} placeholder="name@example.com" />
              {errors.email && <p className="mt-1.5 text-sm text-red-600">{errors.email}</p>}
            </div>
          </div>
          <p id="cust-contact-hint" className={errors.contact ? 'text-sm text-red-600' : 'text-sm text-text-secondary'}>
            {errors.contact ?? 'Enter a phone number or an email address — at least one is required. Booking updates are emailed only when an email is given.'}
          </p>

          {conflict && <ConflictNotice conflict={conflict} />}
          {formError && <p role="alert" className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{formError}</p>}

          <div className="flex flex-wrap justify-end gap-3 pt-2">
            <Link to={editing ? `/customers/${id}` : '/customers'} className="btn-secondary min-h-[48px] px-5">Cancel</Link>
            <button type="submit" className="btn-primary min-h-[48px] px-6 text-base" disabled={saving}>
              {saving ? 'Saving…' : editing ? 'Save Changes' : 'Add Customer'}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
