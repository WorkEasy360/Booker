import React from 'react';
import {
  CalendarDays, CalendarClock, Users, Bell, Home, Clock, BarChart3, Settings, UserRound,
  HelpCircle, Check, X, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, CalendarCheck2,
} from 'lucide-react';
import logoWhite from '@/assets/brand/workeasy360-logo-white.png';
import markImage from '@/assets/brand/workeasy360-mark.png';

/*
 * Left half of the sign-in screen, drawn at the artwork's size (980 × 941 inside the 1672 × 941 canvas of AuthLayout).
 * Every position below is measured from the product artwork, so the page lines up with it point for point.
 */

const FEATURES = [
  { icon: CalendarDays, title: 'Appointment Scheduling', lines: ['Create, manage and reschedule', 'bookings easily'], top: 419 },
  { icon: CalendarClock, title: 'Availability & Calendar', lines: ['Control slots, hours and', 'blocked time'], top: 510 },
  { icon: Users, title: 'Customer Booking', lines: ['Share your booking link and', 'collect bookings online'], top: 601 },
  { icon: Bell, title: 'Staff & Notifications', lines: ['Assign staff and send', 'reminders instantly'], top: 691 },
];

/** Background: deep teal with the glowing green ribbons of the artwork (top right and along the bottom). */
function Waves() {
  return (
    <svg aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 980 941" preserveAspectRatio="none">
      <defs>
        <linearGradient id="hx-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#0A3530" />
          <stop offset="0.5" stopColor="#0B3D35" />
          <stop offset="1" stopColor="#0C4A3D" />
        </linearGradient>
        <linearGradient id="hx-top" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0F6F4E" stopOpacity="0" />
          <stop offset="0.45" stopColor="#14A869" stopOpacity="0.85" />
          <stop offset="1" stopColor="#2FE39B" />
        </linearGradient>
        <linearGradient id="hx-top-in" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#0C5A45" stopOpacity="0.9" />
          <stop offset="1" stopColor="#0E6A50" stopOpacity="0.4" />
        </linearGradient>
        <linearGradient id="hx-green" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#25D982" />
          <stop offset="1" stopColor="#0E9A55" />
        </linearGradient>
        <linearGradient id="hx-dark" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#0B4A3E" />
          <stop offset="0.6" stopColor="#0A3F35" />
          <stop offset="1" stopColor="#0C5543" />
        </linearGradient>
        <radialGradient id="hx-glow" cx="0.98" cy="0.02" r="0.55">
          <stop offset="0" stopColor="#2BE39B" stopOpacity="0.55" />
          <stop offset="1" stopColor="#2BE39B" stopOpacity="0" />
        </radialGradient>
        <filter id="hx-soft" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="2" /></filter>
      </defs>
      <rect width="980" height="941" fill="url(#hx-bg)" />
      <rect width="980" height="941" fill="url(#hx-glow)" />
      {/* top-right ribbon: bright outer sweep with a darker fold inside */}
      <path d="M560 0 C 690 70 780 150 980 330 L980 0 Z" fill="url(#hx-top)" />
      <path d="M640 0 C 750 70 840 120 980 170 L980 0 Z" fill="#1CC983" fillOpacity="0.45" />
      <path d="M600 0 C 700 90 790 175 980 300 L980 340 C 800 210 700 120 560 0 Z" fill="url(#hx-top-in)" filter="url(#hx-soft)" />
      {/* bottom ribbons */}
      <path d="M0 772 C 110 770 210 790 300 830 C 380 866 450 890 560 893 C 700 895 840 820 980 690 L980 941 L0 941 Z" fill="url(#hx-green)" />
      <path d="M0 805 C 120 800 230 830 320 870 C 410 905 520 925 640 905 C 780 880 880 810 980 760 L980 941 L0 941 Z" fill="url(#hx-dark)" />
      <path d="M0 880 C 140 868 260 890 360 941 L0 941 Z" fill="#17B96A" fillOpacity="0.85" />
      <path d="M560 941 C 700 925 840 880 980 840 L980 941 Z" fill="#0F8A55" fillOpacity="0.6" />
      <path d="M0 772 C 110 770 210 790 300 830 C 380 866 450 890 560 893 C 700 895 840 820 980 690" stroke="#5CF0A8" strokeOpacity="0.55" strokeWidth="1.5" fill="none" />
    </svg>
  );
}

/* ── Laptop ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

type Pt = [number, number];

/**
 * CSS matrix3d that maps a w × h box (transform-origin 0 0) onto the quadrilateral tl, tr, br, bl: a projective
 * transform, so the screen sits in the laptop exactly as photographed (turned toward the text, in perspective).
 */
function quadTransform(w: number, h: number, [tl, tr, br, bl]: [Pt, Pt, Pt, Pt]): string {
  const [x0, y0] = tl, [x1, y1] = tr, [x2, y2] = br, [x3, y3] = bl;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / den;
  const k = (dx1 * dy3 - dx3 * dy1) / den;
  const a = x1 - x0 + g * x1, b = x3 - x0 + k * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + k * y3, f = y0;
  const m = [a / w, d / w, 0, g / w, b / h, e / h, 0, k / h, 0, 0, 1, 0, c, f, 0, 1];
  return `matrix3d(${m.map(v => +v.toFixed(8)).join(',')})`;
}

/** Corners measured from the artwork (hero coordinates). */
const SCREEN: [Pt, Pt, Pt, Pt] = [[487, 414], [939, 373], [909.5, 745.5], [439, 737.5]];
const BEZEL: [Pt, Pt, Pt, Pt] = [[475.5, 402.5], [950.5, 356], [918.5, 760.5], [428.5, 749]];
const SCREEN_W = 560;
const SCREEN_H = 360;
const poly = (pts: Pt[]) => pts.map(p => p.join(',')).join(' ');

const MINI_MENU: Array<[React.ElementType, string]> = [
  [Home, 'Dashboard'], [CalendarDays, 'Appointments'], [CalendarDays, 'Calendar'], [Clock, 'Availability'],
  [Users, 'Customers'], [UserRound, 'Staff'], [Bell, 'Notifications'], [BarChart3, 'Reports'], [Settings, 'Settings'],
];

function MiniStat({ icon: Icon, tint, iconColor, label, value, change, down }: {
  icon: React.ElementType; tint: string; iconColor: string; label: string; value: string; change: string; down?: boolean;
}) {
  return (
    <div className="flex-1 bg-white rounded-[7px] shadow-[0_1px_3px_rgba(0,0,0,0.12)] px-[7px] pt-[7px] pb-[5px] flex gap-[6px] items-start">
      <span className="w-[22px] h-[22px] rounded-[5px] flex items-center justify-center mt-[2px] shrink-0" style={{ background: tint }}>
        <Icon className="w-[14px] h-[14px]" style={{ color: iconColor }} strokeWidth={2.2} />
      </span>
      <div className="leading-none">
        <p className="text-[7px] font-semibold text-gray-800 whitespace-nowrap">{label}</p>
        <p className="text-[19px] font-extrabold text-gray-900 mt-[3px]">{value}</p>
        <p className={`text-[8px] font-bold mt-[3px] flex items-center gap-[1px] ${down ? 'text-red-500' : 'text-green-600'}`}>
          {down ? <ArrowDown className="w-[8px] h-[8px]" strokeWidth={3} /> : <ArrowUp className="w-[8px] h-[8px]" strokeWidth={3} />}{change}
        </p>
      </div>
    </div>
  );
}

const CARD = 'bg-white rounded-[7px] shadow-[0_1px_3px_rgba(0,0,0,0.12)]';

/** The booking workspace as shown on the laptop screen. */
function MiniDashboard() {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const cells: Array<number | null> = [null, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
  const bookings: Array<[string, string, string, boolean]> = [
    ['9:00 AM', 'Consultation', 'Checked In', true], ['10:30 AM', 'Haircut', 'Scheduled', false],
    ['1:00 PM', 'Therapy Session', 'Scheduled', false], ['3:30 PM', 'Follow-up', 'Scheduled', false],
  ];
  return (
    <div className="relative bg-gradient-to-br from-[#0B3A32] via-[#0B3F36] to-[#0D4A3D] text-gray-800 overflow-hidden"
      style={{ width: SCREEN_W, height: SCREEN_H, fontFamily: "'Plus Jakarta Sans', Inter, sans-serif" }}>
      {/* top bar */}
      <div className="absolute left-[14px] top-[13px] flex items-center gap-[5px]">
        <img src={markImage} alt="" className="w-[19px] h-[19px]" />
        <span className="text-[16px] font-bold text-white italic tracking-tight">WorkEasy<span className="text-[#2BE086]">360</span> Booking</span>
      </div>
      <div className="absolute right-[12px] top-[8px] flex items-center gap-[14px] text-white">
        <Bell className="w-[16px] h-[16px]" strokeWidth={2} /><HelpCircle className="w-[16px] h-[16px]" strokeWidth={2} /><UserRound className="w-[16px] h-[16px]" strokeWidth={2} />
        <span className="text-[9.5px] font-bold bg-[#17A34A] rounded-full px-[8px] py-[4px]">BO</span>
      </div>
      {/* sidebar */}
      <div className="absolute left-[9px] top-[51px] w-[112px]">
        {MINI_MENU.map(([Icon, label], i) => (
          <div key={label} className={`flex items-center gap-[7px] px-[9px] h-[25px] rounded-[7px] mb-[3.5px] text-[11px] ${i === 0 ? 'bg-[#17A34A] text-white font-bold shadow-[0_2px_6px_rgba(22,163,74,0.5)]' : 'text-white/95 font-semibold'}`}>
            <Icon className="w-[12px] h-[12px]" strokeWidth={2.2} />{label}
          </div>
        ))}
      </div>
      {/* content */}
      <div className="absolute left-[126px] top-[34px] right-[8px] bottom-[4px] rounded-[9px] bg-[#EDF1F4] p-[6px] flex flex-col gap-[7px]">
        <div className="flex gap-[7px] h-[68px] shrink-0">
          <MiniStat icon={CalendarDays} tint="#E3F6EA" iconColor="#16A34A" label="Today's Bookings" value="12" change="+33%" />
          <MiniStat icon={CalendarCheck2} tint="#E3F6EA" iconColor="#16A34A" label="Upcoming" value="28" change="+17%" />
          <MiniStat icon={Check} tint="#DDF3FC" iconColor="#0EA5E9" label="Completed" value="156" change="+12%" />
          <MiniStat icon={X} tint="#FDE4E4" iconColor="#EF4444" label="Cancelled" value="6" change="-25%" down />
        </div>
        <div className="flex gap-[7px] h-[140px] shrink-0">
          <div className={`${CARD} w-[180px] px-[9px] pt-[8px] pb-[5px]`}>
            <div className="flex justify-between items-center mb-[6px]">
              <span className="text-[9px] font-bold">April 2025</span>
              <span className="flex gap-[5px] text-gray-500"><ChevronLeft className="w-[9px] h-[9px]" /><ChevronRight className="w-[9px] h-[9px]" /></span>
            </div>
            <div className="grid grid-cols-7 gap-y-[3.5px] text-center">
              {days.map(d => <span key={d} className="text-[6px] text-gray-500 font-semibold">{d}</span>)}
              {cells.map((d, i) => (
                <span key={i} className={`text-[7.5px] font-semibold mx-auto w-[13px] h-[13px] leading-[13px] rounded-full ${d === 16 ? 'bg-[#16A34A] text-white' : ''}`}>{d ?? ''}</span>
              ))}
            </div>
          </div>
          <div className={`${CARD} flex-1 px-[8px] pt-[7px] pb-[4px] min-w-0`}>
            <div className="flex justify-between mb-[3px]"><span className="text-[9px] font-bold">Today's Bookings</span><span className="text-[7.5px] text-[#16A34A] font-bold">View All →</span></div>
            {bookings.map(([time, svc, status, done]) => (
              <div key={time} className="flex items-center py-[6.5px] border-b border-gray-100 last:border-0">
                <span className="text-[7.5px] font-semibold w-[44px]">{time}</span>
                <span className="text-[7.5px] font-semibold flex-1">{svc}</span>
                <span className={`text-[7px] font-bold px-[5px] py-[2px] rounded-full ${done ? 'bg-green-50 text-green-700' : 'bg-blue-50 text-blue-600'}`}>{done ? '✓ ' : '• '}{status}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex gap-[7px] flex-1 min-h-0">
          <div className={`${CARD} w-[180px] px-[9px] pt-[7px] pb-[5px]`}>
            <div className="flex justify-between mb-[4px]"><span className="text-[8.5px] font-bold">Upcoming Slots</span><span className="text-[7px] text-[#16A34A] font-bold">View Calendar →</span></div>
            {[['4:00 PM', 'Consultation', '3 slots'], ['4:30 PM', 'Massage', '2 slots'], ['5:00 PM', 'Haircut', '4 slots']].map(([t, s, n]) => (
              <div key={t} className="flex items-center py-[3px]">
                <span className="text-[7px] font-semibold w-[34px]">{t}</span><span className="text-[7px] font-semibold flex-1">{s}</span>
                <span className="text-[7px] font-bold bg-green-50 text-green-700 px-[5px] py-[1.5px] rounded-full">{n}</span>
              </div>
            ))}
          </div>
          <div className={`${CARD} flex-1 px-[8px] pt-[7px] pb-[5px]`}>
            <div className="flex justify-between mb-[3px]"><span className="text-[8.5px] font-bold">Customers</span><span className="text-[7px] text-[#16A34A] font-bold">View All →</span></div>
            {[['JS', 'John Smith', '12 bookings', '#16A34A'], ['ER', 'Emma Roberts', '8 bookings', '#F97316'], ['DL', 'Daniel Lee', '6 bookings', '#FDBA74']].map(([i, n, b, c]) => (
              <div key={n} className="flex items-center gap-[5px] py-[2.5px]">
                <span className="w-[15px] h-[15px] rounded-full text-[6px] text-white font-bold flex items-center justify-center" style={{ background: c }}>{i}</span>
                <span className="text-[8px] font-semibold flex-1">{n}</span><span className="text-[7.5px] text-slate-500 font-semibold">{b}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/** Laptop turned toward the text: screen in perspective, silver deck seen from a low angle (front and right side). */
function Laptop() {
  return (
    <div aria-hidden="true" className="absolute inset-0 pointer-events-none">
      <svg className="absolute inset-0" width="980" height="941" viewBox="0 0 980 941">
        <defs>
          <linearGradient id="lt-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#D9DDE1" /><stop offset="0.5" stopColor="#EEF0F2" /><stop offset="1" stopColor="#F7F8F9" />
          </linearGradient>
          <linearGradient id="lt-front" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#B4BAC0" /><stop offset="0.45" stopColor="#E2E5E8" /><stop offset="0.8" stopColor="#C4C9CE" /><stop offset="1" stopColor="#9EA5AB" />
          </linearGradient>
          <linearGradient id="lt-side" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#A9AFB5" /><stop offset="1" stopColor="#D3D7DB" />
          </linearGradient>
          <linearGradient id="lt-rim" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#3A3F44" /><stop offset="1" stopColor="#B9BEC3" />
          </linearGradient>
          <filter id="lt-shadow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="9" /></filter>
        </defs>
        {/* shadow under the deck */}
        <path d="M262 796 L742 822 L920 778 L742 836 Z" fill="#021A15" opacity="0.55" filter="url(#lt-shadow)" />
        {/* lid: silver back rim, then the black bezel */}
        <polygon points={poly([[474, 399.5], [953, 352.5], [921.5, 762], [426, 751]])} fill="url(#lt-rim)" stroke="url(#lt-rim)" strokeWidth="5" strokeLinejoin="round" />
        <polygon points={poly(BEZEL)} fill="#0B0C0D" stroke="#0B0C0D" strokeWidth="8" strokeLinejoin="round" />
        {/* webcam */}
        <circle cx="712" cy="381" r="1.6" fill="#2A2F33" />
        {/* deck: top surface, keyboard band, thumb notch, front edge, right side with ports */}
        <polygon points={poly([[426, 751], [921, 762], [741, 799], [257, 777]])} fill="url(#lt-top)" />
        <polygon points={poly([[366, 759], [846, 763], [772, 782], [366, 768]])} fill="#1A1D20" />
        <polygon points={poly([[366, 759], [846, 763], [840, 765], [366, 761]])} fill="#3B4045" />
        {/* keys: gaps between the rows and columns of the keyboard */}
        <g stroke="#5A6066" strokeWidth="0.7" strokeOpacity="0.8">
          {[0.3, 0.55, 0.8].map(t => (
            <line key={t} x1={366} y1={761 + 7 * t} x2={846 - 74 * t} y2={763 + 19 * t} />
          ))}
          {Array.from({ length: 30 }, (_, i) => {
            const x = 380 + i * 15.5;
            const top = 759.5 + (x - 366) * (4 / 480);
            const bottom = 767.5 + (x - 366) * (14.5 / 406);
            return x < 835 ? <line key={i} x1={x} y1={top} x2={x - 2} y2={Math.min(bottom, 782)} /> : null;
          })}
        </g>
        <polygon points={poly([[257, 777], [741, 799], [740, 815], [262, 790]])} fill="url(#lt-front)" />
        <path d="M450 786 C 460 791 535 796 545 795 L 545 798 C 530 800 465 796 452 792 Z" fill="#F4F6F7" stroke="#B9BFC4" strokeWidth="0.6" />
        <polygon points={poly([[741, 799], [921, 762], [919, 772], [740, 815]])} fill="url(#lt-side)" />
        <g stroke="#26292C" strokeWidth="3.2" strokeLinecap="round">
          <line x1="851" y1="783.5" x2="862" y2="781" /><line x1="869" y1="779" x2="880" y2="776.5" /><line x1="887" y1="775" x2="897" y2="772.5" />
        </g>
        <polyline points={poly([[257, 777], [741, 799], [921, 762]])} fill="none" stroke="#FFFFFF" strokeOpacity="0.85" strokeWidth="1" />
      </svg>
      {/* the screen, projected onto the measured corners */}
      <div className="absolute left-0 top-0 origin-top-left" style={{ width: SCREEN_W, height: SCREEN_H, transform: quadTransform(SCREEN_W, SCREEN_H, SCREEN) }}>
        <MiniDashboard />
        {/* glass reflection */}
        <div className="absolute inset-0 bg-[linear-gradient(115deg,rgba(255,255,255,0.10)_0%,rgba(255,255,255,0)_35%)]" />
      </div>
    </div>
  );
}

/** Left half of the sign-in screens: product introduction, the four features and the laptop. */
export function BookingHero() {
  return (
    <section aria-label="WorkEasy Booking" className="relative h-full overflow-hidden text-white font-jakarta">
      <Waves />
      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[980px] h-[941px]">
        <img src={logoWhite} alt="WorkEasy360" className="absolute left-[62px] top-[23px] w-[338px] h-auto" draggable={false} />

        <span className="absolute left-[62px] top-[117px] w-[241px] h-[59px] rounded-[16px] bg-[linear-gradient(180deg,#2BC764_0%,#16A043_55%,#0E8C38_100%)] shadow-[0_0_24px_rgba(34,197,94,0.45),inset_0_1px_0_rgba(255,255,255,0.35)] flex items-center pl-[25px] gap-[17px]">
          <CalendarDays className="w-[42px] h-[42px]" strokeWidth={1.7} aria-hidden="true" />
          <span className="text-[29px] font-bold tracking-[0.01em] leading-none">BOOKING</span>
        </span>

        <h2 className="absolute left-[64px] top-[180px] text-[64px] leading-[80px] font-extrabold tracking-[-0.025em] whitespace-nowrap [text-shadow:0_3px_10px_rgba(0,0,0,0.35)]">
          WorkEasy <span className="text-[#23E07A]">Booking</span>
        </h2>
        <p className="absolute left-[66px] top-[259px] text-[31.5px] leading-[42px] font-bold tracking-[-0.012em] whitespace-nowrap [text-shadow:0_2px_6px_rgba(0,0,0,0.3)]">
          Simple Appointment Scheduling for Growing Businesses
        </p>
        <p className="absolute left-[66px] top-[310px] text-[22.6px] leading-[29.5px] font-medium text-white/95 whitespace-nowrap">
          Manage appointments, availability, staff calendars and<br />customer bookings from one easy platform.
        </p>

        <ul>
          {FEATURES.map(f => (
            <li key={f.title} className="absolute left-[69px]" style={{ top: f.top }}>
              <span className="absolute left-0 top-0 w-[72px] h-[69px] rounded-[16px] bg-[linear-gradient(180deg,#34CB6C_0%,#17A146_60%,#0F8A3A_100%)] shadow-[0_6px_18px_rgba(0,0,0,0.25),inset_0_1px_0_rgba(255,255,255,0.3)] flex items-center justify-center">
                <f.icon className="w-[42px] h-[42px]" strokeWidth={1.7} aria-hidden="true" />
              </span>
              <span className="absolute left-[89px] -top-[4px] whitespace-nowrap">
                <span className="block text-[23px] leading-[32px] font-bold tracking-[-0.02em] [text-shadow:0_2px_6px_rgba(0,0,0,0.3)]">{f.title}</span>
                <span className="block text-[17px] leading-[22px] font-medium text-white/95">{f.lines[0]}<br />{f.lines[1]}</span>
              </span>
            </li>
          ))}
        </ul>

        <Laptop />
      </div>
    </section>
  );
}
