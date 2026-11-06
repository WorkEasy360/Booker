// English and Hindi text for the parts of the app that are translated: the customer booking pages (steps, forms,
// validation, review, manage booking), appointment statuses, navigation, sign-in and the language setting.
// Every Hindi entry must exist for every English key (checked in tests/unit/i18n.test.ts). {name} marks a value.

export const LANGUAGES = [
  { code: 'en', label: 'English' },
  { code: 'hi', label: 'हिन्दी (Hindi)' },
] as const;
export type Language = typeof LANGUAGES[number]['code'];

const en = {
  // Booking steps
  'step.service': 'Service', 'step.staff': 'Staff', 'step.date': 'Date', 'step.time': 'Time', 'step.info': 'Your Info', 'step.review': 'Review',
  'step.progress': 'Step {step} of {total}', 'step.progressLabel': 'Booking progress',
  'service.title': 'Select a Service', 'service.subtitle': "Choose the service you'd like to book",
  'service.none': 'No services available on this booking page.',
  'staff.title': 'Choose a Provider', 'staff.subtitle': "Select who you'd like to see, or let us assign the best available",
  'staff.any': 'Any available staff', 'staff.anyHint': "We'll assign the next available provider",
  'date.title': 'Select a Date', 'date.subtitle': 'Only days with free appointment times can be selected.',
  'time.title': 'Select a Time', 'time.subtitle': 'Available times on {date}', 'time.morning': 'Morning', 'time.afternoon': 'Afternoon',
  'time.unavailable': 'Unavailable', 'time.slotLabel': '{start} to {end}', 'time.slotUnavailable': '{start}, unavailable',
  'time.loadFailed': 'Failed to load available times.', 'time.tryOther': 'Please go back and try a different date or staff member.',
  'time.noneLeft': 'No times are free on {date} any more.', 'time.noneLeftHint': 'Someone may have just booked the last slot. Go back and choose another date.',
  'info.title': 'Your Information', 'info.name': 'Full Name', 'info.email': 'Email Address', 'info.phone': 'Phone Number', 'info.optional': '(optional)',
  'info.namePlaceholder': 'Jane Smith',
  'info.nameRequired': 'Enter your name.', 'info.emailRequired': 'Enter your email address.', 'info.phoneRequired': 'Enter your phone number.',
  'info.summary': 'Summary', 'info.payDirectly': 'Online payment is not available. Pay the business directly.',
  // Text-message consent, add to calendar, message status after booking
  'consent.title': 'Booking updates by message', 'consent.sms': 'Text me booking updates (SMS)', 'consent.whatsapp': 'Send me booking updates on WhatsApp',
  'consent.hint': 'Optional. Your confirmation always comes by email. Reply STOP to any message to stop them.',
  'consent.needsPhone': 'Add your phone number above to get messages.',
  'cal.title': 'Add to calendar', 'cal.google': 'Google Calendar', 'cal.outlook': 'Outlook', 'cal.file': 'Apple Calendar (.ics file)',
  'cal.hint': 'Opens your own calendar with the booking filled in. If the booking changes later, update the event there too.',
  'cal.fileUnavailable': 'The calendar file is attached to your confirmation email.',
  'cal.fileFailed': 'Could not download the calendar file. It is also attached to your confirmation email.',
  'msg.sms.sent': 'We sent your booking details by text message.', 'msg.sms.queued': 'Your booking details will also be sent by text message.',
  'msg.sms.not_sent': 'We could not send a text message to your number. Your booking is still confirmed.',
  'msg.whatsapp.sent': 'We sent your booking details on WhatsApp.', 'msg.whatsapp.queued': 'Your booking details will also be sent on WhatsApp.',
  'msg.whatsapp.not_sent': 'We could not send a WhatsApp message to your number. Your booking is still confirmed.',
  'review.title': 'Review Your Booking', 'review.subtitle': 'Please confirm all details are correct',
  'field.service': 'Service', 'field.duration': 'Duration', 'field.price': 'Price', 'field.provider': 'Provider', 'field.date': 'Date',
  'field.time': 'Time', 'field.name': 'Name', 'field.email': 'Email', 'field.phone': 'Phone', 'field.reference': 'Reference',
  'nav.back': 'Back', 'nav.continue': 'Continue', 'nav.confirm': 'Confirm Booking',
  'block.service': 'Select a service to continue.', 'block.staffLoading': 'Loading staff for this service…',
  'block.noStaff': 'No staff offer this service online yet. Please choose another service or contact the business.',
  'block.date': 'Select a date to continue.', 'block.time': 'Select a time slot to continue.',
  'block.name': 'Enter your name to continue.', 'block.email': 'Enter your email to continue.',
  'block.emailInvalid': 'Enter a valid email address to continue.', 'block.phone': 'Enter your phone number to continue.',
  'block.phoneInvalid': 'Enter a valid phone number to continue.', 'block.answer': 'Answer "{label}" to continue.',
  'block.answerInvalid': 'Check your answer to "{label}" to continue.',
  'booking.noStaff': 'No staff are available for this service.', 'booking.failed': 'Booking failed. Please try again.',
  'page.notFound': 'Booking page not found.', 'page.findExisting': 'Find an existing booking',
  'language.label': 'Language',
  // Validation (shared with the web forms)
  'valid.email': 'Enter a valid email address, for example name@example.com.',
  'valid.phone': 'Enter a valid phone number, for example {example}.',
  // Statuses
  'status.scheduled': 'Scheduled', 'status.confirmed': 'Confirmed', 'status.completed': 'Completed', 'status.cancelled': 'Cancelled', 'status.no_show': 'No-show',
  // Manage booking
  'manage.title': 'Manage Your Booking', 'manage.subtitle': 'Enter your booking reference and the email address you booked with',
  'manage.ref': 'Booking reference', 'manage.email': 'Email address', 'manage.emailPlaceholder': 'The email on your booking',
  'manage.find': 'Find my booking', 'manage.finding': 'Finding…', 'manage.bothRequired': 'Enter your booking reference and the email address you booked with.',
  'manage.whereToFind': 'Both are in your confirmation email, which also has a direct link to manage your booking.',
  'manage.sendLink': 'Lost the email? Email me a link to manage my booking', 'manage.sending': 'Sending…',
  'manage.details': 'Booking Details', 'manage.reschedule': 'Reschedule', 'manage.cancel': 'Cancel Booking',
  'manage.started': 'This appointment has already started, so it can no longer be changed online. Please contact the business.',
  'manage.bookNew': 'Book a new appointment', 'manage.cancelledTitle': 'Booking Cancelled',
  'manage.cancelledText': 'Your appointment has been successfully cancelled. We hope to see you again soon.',
  'manage.help': 'Need help?', 'manage.helpGeneric': 'Contact the business you booked with. Their details are in your confirmation email.',
  'manage.loading': 'Loading your booking…',
  // Navigation
  'menu.dashboard': 'Dashboard', 'menu.mySpace': 'My Space', 'menu.appointments': 'Appointments', 'menu.calendar': 'Calendar',
  'menu.workspaces': 'Workspaces', 'menu.services': 'Services', 'menu.staff': 'Staff', 'menu.resources': 'Resources',
  'menu.customers': 'Customers', 'menu.bookingPages': 'Booking Pages', 'menu.notifications': 'Notifications',
  'menu.integrations': 'Integrations', 'menu.reports': 'Reports', 'menu.settings': 'Settings', 'menu.signOut': 'Sign Out',
  // Sign-in
  'login.title': 'Welcome back', 'login.subtitle': 'Sign in to {product}', 'login.email': 'Email', 'login.password': 'Password',
  'login.forgot': 'Forgot password?', 'login.submit': 'Sign in', 'login.submitting': 'Signing in…',
  'login.required': 'Email and password are required.', 'login.noAccount': "Don't have an account?", 'login.create': 'Create account',
} as const;

export type MessageKey = keyof typeof en;

const hi: Record<MessageKey, string> = {
  'step.service': 'सेवा', 'step.staff': 'स्टाफ़', 'step.date': 'तारीख़', 'step.time': 'समय', 'step.info': 'आपकी जानकारी', 'step.review': 'समीक्षा',
  'step.progress': 'चरण {step} / {total}', 'step.progressLabel': 'बुकिंग की प्रगति',
  'service.title': 'सेवा चुनें', 'service.subtitle': 'वह सेवा चुनें जिसे आप बुक करना चाहते हैं',
  'service.none': 'इस बुकिंग पेज पर कोई सेवा उपलब्ध नहीं है।',
  'staff.title': 'सेवा प्रदाता चुनें', 'staff.subtitle': 'चुनें कि आप किससे मिलना चाहते हैं, या हमें सबसे उपयुक्त व्यक्ति चुनने दें',
  'staff.any': 'कोई भी उपलब्ध स्टाफ़', 'staff.anyHint': 'हम अगला उपलब्ध सेवा प्रदाता तय करेंगे',
  'date.title': 'तारीख़ चुनें', 'date.subtitle': 'केवल वही दिन चुने जा सकते हैं जिनमें ख़ाली समय है।',
  'time.title': 'समय चुनें', 'time.subtitle': '{date} को उपलब्ध समय', 'time.morning': 'सुबह', 'time.afternoon': 'दोपहर/शाम',
  'time.unavailable': 'उपलब्ध नहीं', 'time.slotLabel': '{start} से {end}', 'time.slotUnavailable': '{start}, उपलब्ध नहीं',
  'time.loadFailed': 'उपलब्ध समय लोड नहीं हो सके।', 'time.tryOther': 'कृपया वापस जाएँ और कोई दूसरी तारीख़ या स्टाफ़ चुनें।',
  'time.noneLeft': '{date} को अब कोई समय ख़ाली नहीं है।', 'time.noneLeftHint': 'शायद किसी ने अभी-अभी आख़िरी समय बुक कर लिया। वापस जाकर कोई दूसरी तारीख़ चुनें।',
  'info.title': 'आपकी जानकारी', 'info.name': 'पूरा नाम', 'info.email': 'ईमेल पता', 'info.phone': 'फ़ोन नंबर', 'info.optional': '(वैकल्पिक)',
  'info.namePlaceholder': 'प्रिया शर्मा',
  'info.nameRequired': 'अपना नाम लिखें।', 'info.emailRequired': 'अपना ईमेल पता लिखें।', 'info.phoneRequired': 'अपना फ़ोन नंबर लिखें।',
  'info.summary': 'सारांश', 'info.payDirectly': 'ऑनलाइन भुगतान उपलब्ध नहीं है। भुगतान सीधे व्यवसाय को करें।',
  'consent.title': 'मैसेज से बुकिंग अपडेट', 'consent.sms': 'मुझे बुकिंग अपडेट SMS से भेजें', 'consent.whatsapp': 'मुझे बुकिंग अपडेट WhatsApp पर भेजें',
  'consent.hint': 'वैकल्पिक। पुष्टि हमेशा ईमेल से आती है। मैसेज बंद करने के लिए किसी भी मैसेज के जवाब में STOP लिखें।',
  'consent.needsPhone': 'मैसेज पाने के लिए ऊपर अपना फ़ोन नंबर लिखें।',
  'cal.title': 'कैलेंडर में जोड़ें', 'cal.google': 'Google कैलेंडर', 'cal.outlook': 'Outlook कैलेंडर', 'cal.file': 'Apple Calendar (.ics फ़ाइल)',
  'cal.hint': 'आपका अपना कैलेंडर बुकिंग की जानकारी के साथ खुलेगा। बाद में बुकिंग बदले तो वहाँ भी इवेंट बदलें।',
  'cal.fileUnavailable': 'कैलेंडर फ़ाइल आपके पुष्टि ईमेल के साथ जुड़ी है।',
  'cal.fileFailed': 'कैलेंडर फ़ाइल डाउनलोड नहीं हो सकी। यह आपके पुष्टि ईमेल के साथ भी जुड़ी है।',
  'msg.sms.sent': 'हमने बुकिंग की जानकारी SMS से भेज दी है।', 'msg.sms.queued': 'बुकिंग की जानकारी SMS से भी भेजी जाएगी।',
  'msg.sms.not_sent': 'आपके नंबर पर SMS नहीं भेजा जा सका। आपकी बुकिंग फिर भी पक्की है।',
  'msg.whatsapp.sent': 'हमने बुकिंग की जानकारी WhatsApp पर भेज दी है।', 'msg.whatsapp.queued': 'बुकिंग की जानकारी WhatsApp पर भी भेजी जाएगी।',
  'msg.whatsapp.not_sent': 'आपके नंबर पर WhatsApp मैसेज नहीं भेजा जा सका। आपकी बुकिंग फिर भी पक्की है।',
  'review.title': 'अपनी बुकिंग जाँचें', 'review.subtitle': 'कृपया पुष्टि करें कि सभी विवरण सही हैं',
  'field.service': 'सेवा', 'field.duration': 'अवधि', 'field.price': 'मूल्य', 'field.provider': 'सेवा प्रदाता', 'field.date': 'तारीख़',
  'field.time': 'समय', 'field.name': 'नाम', 'field.email': 'ईमेल', 'field.phone': 'फ़ोन', 'field.reference': 'संदर्भ संख्या',
  'nav.back': 'वापस', 'nav.continue': 'आगे बढ़ें', 'nav.confirm': 'बुकिंग की पुष्टि करें',
  'block.service': 'आगे बढ़ने के लिए सेवा चुनें।', 'block.staffLoading': 'इस सेवा के स्टाफ़ लोड हो रहे हैं…',
  'block.noStaff': 'अभी कोई स्टाफ़ यह सेवा ऑनलाइन नहीं देता। कृपया कोई दूसरी सेवा चुनें या व्यवसाय से संपर्क करें।',
  'block.date': 'आगे बढ़ने के लिए तारीख़ चुनें।', 'block.time': 'आगे बढ़ने के लिए समय चुनें।',
  'block.name': 'आगे बढ़ने के लिए अपना नाम लिखें।', 'block.email': 'आगे बढ़ने के लिए अपना ईमेल लिखें।',
  'block.emailInvalid': 'आगे बढ़ने के लिए सही ईमेल पता लिखें।', 'block.phone': 'आगे बढ़ने के लिए अपना फ़ोन नंबर लिखें।',
  'block.phoneInvalid': 'आगे बढ़ने के लिए सही फ़ोन नंबर लिखें।', 'block.answer': 'आगे बढ़ने के लिए "{label}" का उत्तर दें।',
  'block.answerInvalid': 'आगे बढ़ने के लिए "{label}" का उत्तर जाँचें।',
  'booking.noStaff': 'इस सेवा के लिए कोई स्टाफ़ उपलब्ध नहीं है।', 'booking.failed': 'बुकिंग नहीं हो सकी। कृपया फिर से कोशिश करें।',
  'page.notFound': 'बुकिंग पेज नहीं मिला।', 'page.findExisting': 'मौजूदा बुकिंग खोजें',
  'language.label': 'भाषा',
  'valid.email': 'सही ईमेल पता लिखें, जैसे name@example.com।',
  'valid.phone': 'सही फ़ोन नंबर लिखें, जैसे {example}।',
  'status.scheduled': 'निर्धारित', 'status.confirmed': 'पुष्ट', 'status.completed': 'पूर्ण', 'status.cancelled': 'रद्द', 'status.no_show': 'नहीं आए',
  'manage.title': 'अपनी बुकिंग प्रबंधित करें', 'manage.subtitle': 'अपनी बुकिंग संदर्भ संख्या और बुकिंग के समय दिया गया ईमेल पता लिखें',
  'manage.ref': 'बुकिंग संदर्भ संख्या', 'manage.email': 'ईमेल पता', 'manage.emailPlaceholder': 'आपकी बुकिंग वाला ईमेल',
  'manage.find': 'मेरी बुकिंग खोजें', 'manage.finding': 'खोज रहे हैं…', 'manage.bothRequired': 'अपनी बुकिंग संदर्भ संख्या और बुकिंग वाला ईमेल पता लिखें।',
  'manage.whereToFind': 'दोनों आपके पुष्टि ईमेल में हैं, जिसमें बुकिंग प्रबंधित करने का सीधा लिंक भी है।',
  'manage.sendLink': 'ईमेल नहीं मिल रहा? बुकिंग प्रबंधित करने का लिंक मुझे ईमेल करें', 'manage.sending': 'भेज रहे हैं…',
  'manage.details': 'बुकिंग का विवरण', 'manage.reschedule': 'समय बदलें', 'manage.cancel': 'बुकिंग रद्द करें',
  'manage.started': 'यह अपॉइंटमेंट शुरू हो चुका है, इसलिए अब इसे ऑनलाइन नहीं बदला जा सकता। कृपया व्यवसाय से संपर्क करें।',
  'manage.bookNew': 'नया अपॉइंटमेंट बुक करें', 'manage.cancelledTitle': 'बुकिंग रद्द हो गई',
  'manage.cancelledText': 'आपका अपॉइंटमेंट रद्द कर दिया गया है। हमें आपसे फिर मिलने की उम्मीद है।',
  'manage.help': 'सहायता चाहिए?', 'manage.helpGeneric': 'जिस व्यवसाय में बुकिंग की है उससे संपर्क करें। उनका विवरण आपके पुष्टि ईमेल में है।',
  'manage.loading': 'आपकी बुकिंग लोड हो रही है…',
  'menu.dashboard': 'डैशबोर्ड', 'menu.mySpace': 'मेरा स्थान', 'menu.appointments': 'अपॉइंटमेंट', 'menu.calendar': 'कैलेंडर',
  'menu.workspaces': 'कार्यस्थल', 'menu.services': 'सेवाएँ', 'menu.staff': 'स्टाफ़', 'menu.resources': 'संसाधन',
  'menu.customers': 'ग्राहक', 'menu.bookingPages': 'बुकिंग पेज', 'menu.notifications': 'सूचनाएँ',
  'menu.integrations': 'इंटीग्रेशन', 'menu.reports': 'रिपोर्ट', 'menu.settings': 'सेटिंग्स', 'menu.signOut': 'साइन आउट',
  'login.title': 'फिर से स्वागत है', 'login.subtitle': '{product} में साइन इन करें', 'login.email': 'ईमेल', 'login.password': 'पासवर्ड',
  'login.forgot': 'पासवर्ड भूल गए?', 'login.submit': 'साइन इन करें', 'login.submitting': 'साइन इन हो रहा है…',
  'login.required': 'ईमेल और पासवर्ड ज़रूरी हैं।', 'login.noAccount': 'खाता नहीं है?', 'login.create': 'खाता बनाएँ',
};

export const MESSAGES: Record<Language, Record<MessageKey, string>> = { en, hi };

/** The text for a key in a language, with {name} values filled in. Falls back to English. */
export function translate(lang: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  const text = MESSAGES[lang]?.[key] ?? en[key];
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function isLanguage(v: unknown): v is Language {
  return v === 'en' || v === 'hi';
}
