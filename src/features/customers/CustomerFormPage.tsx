import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Input, Select, Textarea, PageHeader, useToast } from '@/components/ui';
import { usePageTitle } from '@/hooks/usePageTitle';
import { customersApi } from '@/api/client';
import { TIMEZONES } from '@/lib/utils';
import { emailError, phoneError, PHONE_PLACEHOLDER } from '@/lib/validation';
import { useTouched } from '@/hooks/useTouched';

const ALL_TAGS = ['regular', 'vip', 'corporate', 'sports', 'referral', 'new'];

const TZ_OPTIONS = [
  { value: '', label: 'Select timezone (optional)' },
  ...TIMEZONES.map(tz => ({ value: tz, label: tz })),
];

export default function CustomerFormPage() {
  const navigate = useNavigate();
  const toast = useToast();
  usePageTitle('New Customer');

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [timezone, setTimezone] = useState('');
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(false);

  function toggleTag(tag: string) {
    setSelectedTags(prev =>
      prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]
    );
  }

  const [touched, touch] = useTouched();
  const emailMsg = touched.email ? (email.trim() ? emailError(email) : 'Email is required') : '';
  const phoneMsg = touched.phone ? phoneError(phone) : '';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    touch('email', 'phone');
    if (!name.trim() || !email.trim() || emailError(email) || phoneError(phone)) return;
    setLoading(true);
    try {
      await customersApi.create({
        name: name.trim(),
        email: email.trim(),
        phone: phone.trim() || undefined,
        timezone: timezone || undefined,
        tags: selectedTags,
        notes: notes.trim(),
      });
      toast.success('Customer created successfully');
      navigate('/customers');
    } catch (e: unknown) {
      toast.error('Failed to create customer', (e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const isValid = name.trim().length > 0 && email.trim().length > 0 && !emailError(email) && !phoneError(phone);

  return (
    <div className="page-container">
      <PageHeader
        title="Add Customer"
        description="Create a new customer profile"
        breadcrumbs={[{ label: 'Customers', href: '/customers' }, { label: 'New Customer' }]}
      />

      <form onSubmit={handleSubmit} className="max-w-lg">
        <div className="card p-6 space-y-5">
          <Input
            label="Full Name"
            required
            placeholder="e.g. Jane Smith"
            value={name}
            onChange={e => setName(e.target.value)}
          />

          <Input
            label="Email Address"
            required
            type="email"
            placeholder="jane@example.com"
            value={email}
            onChange={e => setEmail(e.target.value)}
            onBlur={() => touch('email')}
            error={emailMsg}
          />

          <Input
            label="Phone"
            type="tel"
            placeholder={PHONE_PLACEHOLDER}
            value={phone}
            onChange={e => setPhone(e.target.value)}
            onBlur={() => touch('phone')}
            error={phoneMsg}
          />

          <Select
            label="Timezone"
            options={TZ_OPTIONS}
            value={timezone}
            onChange={e => setTimezone(e.target.value)}
          />

          <div>
            <p className="block text-sm font-medium text-text-primary mb-2">Tags</p>
            <div className="grid grid-cols-2 gap-2">
              {ALL_TAGS.map(tag => (
                <label
                  key={tag}
                  className="flex items-center gap-2.5 cursor-pointer group"
                >
                  <input
                    type="checkbox"
                    checked={selectedTags.includes(tag)}
                    onChange={() => toggleTag(tag)}
                    className="w-4 h-4 rounded border-border text-primary focus:ring-primary accent-primary"
                  />
                  <span className="text-sm text-text-secondary group-hover:text-text-primary capitalize transition-colors">
                    {tag}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <Textarea
            label="Notes"
            hint="Internal notes, visible to staff only."
            rows={4}
            placeholder="Any relevant notes about this customer..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="flex items-center gap-3 mt-6">
          <Button type="submit" loading={loading} disabled={!isValid}>
            Create Customer
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => navigate('/customers')}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  );
}
