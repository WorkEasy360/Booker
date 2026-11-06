import React, { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import AuthLayout from './AuthLayout';
import { Notice, TEXT_LINK } from './authUi';
import ResendLink from './ResendLink';

/** Shown after a sign-up request: the account is created when the emailed link is confirmed, then the person signs in. */
export default function CheckEmailPanel({ email, message, onUseDifferentEmail }: { email: string; message: string; onUseDifferentEmail: () => void }) {
  const noticeRef = useRef<HTMLDivElement>(null);
  useEffect(() => { noticeRef.current?.focus(); }, []);

  return (
    <AuthLayout title="Check your email" subtitle="One more step to create your account">
      <Notice ref={noticeRef} tone="success">{message}</Notice>
      <p className="text-sm text-gray-700 mb-2">
        Open the link in the email to confirm <strong className="break-words">{email}</strong> and finish creating your
        account, then sign in. The link works once and expires after 24 hours.
      </p>
      <p className="text-sm text-gray-500 mb-4">Nothing after a few minutes? Check your spam folder, or send a new link.</p>
      <ResendLink email={email} />
      <div className="mt-5 flex items-center justify-between text-sm">
        <button type="button" onClick={onUseDifferentEmail} className={TEXT_LINK}>Use a different email</button>
        <Link to="/login" className={TEXT_LINK}>Back to sign in</Link>
      </div>
    </AuthLayout>
  );
}
