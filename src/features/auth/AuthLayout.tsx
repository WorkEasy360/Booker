import React, { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { homePath } from '@/lib/permissions';
import { copyrightNotice } from '@/lib/brand';
import { usePageTitle } from '@/hooks/usePageTitle';
import { BrandedLoader } from '@/components/brand';
import logoColor from '@/assets/brand/workeasy360-logo.png';
import { BookingHero } from './BookingHero';
import { isDesktopWindow } from '@/hooks/useDesignScale';

interface Props {
  children: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  /** Browser tab title (before " — WorkEasy360 Booking"); defaults to `title`. */
  documentTitle?: string;
  /** Send signed-in users to their home page (off for pages that handle a signed-in user themselves). */
  redirectIfSignedIn?: boolean;
}

/** Size the sign-in screen was designed at (the product artwork). */
const DESIGN_W = 1672;
const DESIGN_H = 941;

interface Fit { scale: number; width: number; height: number; canvas: boolean }

/**
 * On laptop and desktop windows the sign-in screen is drawn at its design size and scaled to fill the window exactly,
 * so it always fits on one screen (no scrolling) with the same proportions as the artwork, whatever the window size or
 * browser zoom. The canvas grows in width or height to cover the window, so there are no empty bars. Phones and
 * portrait tablets get the stacked layout instead.
 */
function useFit(): Fit {
  const measure = (): Fit => {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Fitted to the window, at most 90% of the artwork (text stays a comfortable size on big monitors).
    const scale = Math.min(vw / DESIGN_W, vh / DESIGN_H, 0.9);
    // Laptop and desktop windows (the same rule as the signed-in app), landscape: the artwork canvas.
    return { scale, width: vw / scale, height: vh / scale, canvas: (vw >= 1024 || isDesktopWindow()) && vw / vh >= 1.2 };
  };
  const [fit, setFit] = useState<Fit>(measure);
  useEffect(() => {
    const onResize = () => setFit(measure());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return fit;
}

/** "WorkEasy360 | BOOKING" lockup at the top of the sign-in card (desktop sizes measured from the artwork). */
export function BookingLockup() {
  return (
    <div className="flex items-center justify-center gap-3 sm:gap-4 lg:justify-start lg:gap-0 lg:ml-[36px] lg:h-[49px]">
      <img src={logoColor} alt="WorkEasy360" className="h-8 sm:h-10 lg:h-[47px] w-auto" draggable={false} />
      <span className="w-px h-9 sm:h-11 lg:w-[2.5px] lg:h-[35px] lg:ml-[22px] bg-gray-300 lg:bg-[#1F2937]" aria-hidden="true" />
      <span className="inline-flex items-center justify-center rounded-xl lg:rounded-[12px] bg-brand-button lg:bg-[linear-gradient(180deg,#1DB04A_0%,#0F8D33_60%,#0A7A2B_100%)] px-3 sm:px-4 lg:px-0 py-1.5 sm:py-2 lg:py-0 lg:ml-[25px] lg:w-[150px] lg:h-[43px] text-white font-display lg:font-jakarta font-semibold lg:font-extrabold text-[19px] sm:text-[25px] lg:text-[28px] leading-none tracking-wide lg:tracking-[0.005em] shadow-button lg:shadow-[0_2px_6px_rgba(21,128,61,0.35),inset_0_1px_0_rgba(255,255,255,0.3)]">
        BOOKING
      </span>
    </div>
  );
}

function Card({ title, subtitle, children }: Pick<Props, 'title' | 'subtitle' | 'children'>) {
  return (
    <main className="w-full max-w-[600px] lg:max-w-none lg:w-[622px] lg:min-h-[858px] bg-white rounded-[28px] lg:rounded-[24px] shadow-[0_10px_40px_rgba(15,23,42,0.08)] border border-white px-5 py-8 sm:px-10 sm:py-11 lg:pl-[40px] lg:pr-[37px] lg:pt-[41px] lg:pb-[30px] lg:font-jakarta">
      <header className="text-center">
        <BookingLockup />
        <h1 className="mt-6 lg:mt-[16px] text-[30px] sm:text-[38px] lg:text-[42px] font-bold lg:font-extrabold text-[#0F172A] tracking-tight lg:tracking-[-0.02em] leading-tight lg:leading-[50px]">{title}</h1>
        <p className="mt-2 lg:mt-[6px] text-[15px] sm:text-[18px] lg:text-[19px] text-[#3F5068] lg:text-[#2E4A6E] leading-snug lg:leading-[27.5px] lg:tracking-[-0.005em] max-w-[480px] lg:max-w-none mx-auto">{subtitle}</p>
      </header>
      <div className="mt-7 lg:mt-[22px]">{children}</div>
    </main>
  );
}

/** Shared frame of the sign-in, sign-up, password and invitation pages: product hero on the left, form card on the right. */
export default function AuthLayout({ children, title, subtitle, documentTitle, redirectIfSignedIn = true }: Props) {
  const { user, isLoading } = useAuth();
  usePageTitle(documentTitle ?? title);
  const fit = useFit();

  if (isLoading) return <BrandedLoader tone="dark" />;
  if (user && redirectIfSignedIn) return <Navigate to={homePath(user.permissions)} replace />;

  if (!fit.canvas) {
    // Phones and portrait tablets: the form card alone, scrolling normally.
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-4 py-8 sm:px-8 bg-[#EEF2F6]">
        <Card title={title} subtitle={subtitle}>{children}</Card>
        <p className="mt-5 text-xs text-[#64748B]">{copyrightNotice()}. Secure access only.</p>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#EEF2F6]">
      <div
        className="grid grid-cols-[minmax(0,980fr)_minmax(0,692fr)] origin-top-left"
        style={{ width: fit.width, height: fit.height, transform: `scale(${fit.scale})` }}
      >
        <BookingHero />
        {/* The card sits where it does in the artwork; taller forms (sign-up) scroll inside this column. */}
        <div className="h-full overflow-y-auto flex [align-items:safe_center] justify-center bg-[linear-gradient(90deg,#EBF0F6_0%,#EEF2F7_100%)]">
          <div className="w-[692px] shrink-0 pl-[41px] pr-[29px] pt-[34px] pb-[48px]">
            <Card title={title} subtitle={subtitle}>{children}</Card>
          </div>
        </div>
      </div>
    </div>
  );
}
