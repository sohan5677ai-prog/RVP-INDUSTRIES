import type { WishCategory } from './types';

export type FestivalCategory = WishCategory | 'ALL';
export type FestivalType = 'NATIONAL_HOLIDAY' | 'GAZETTED' | 'RESTRICTED' | 'FESTIVAL';

export interface FestivalItem {
  id: string;
  name: string;
  date: string; // YYYY-MM-DD
  category: FestivalCategory;
  type: FestivalType;
  description: string;
  defaultGreeting: string;
}

// Curated list of Indian festivals & holidays for 2025, 2026, and 2027
export const FESTIVAL_DATABASE: Omit<FestivalItem, 'id'>[] = [
  // --- 2025 ---
  {
    name: "New Year's Day",
    date: '2025-01-01',
    category: 'ALL',
    type: 'GAZETTED',
    description: 'First day of the Gregorian New Year.',
    defaultGreeting: 'Wishing you and your family a very Happy and Prosperous New Year!',
  },
  {
    name: 'Makar Sankranti / Pongal / Lohri',
    date: '2025-01-14',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Harvest festival celebrated across India with kites, bonfires, and feasts.',
    defaultGreeting: 'Warm wishes on Makar Sankranti and Pongal! May this harvest season bring abundance and prosperity.',
  },
  {
    name: 'Republic Day',
    date: '2025-01-26',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'National holiday marking the adoption of the Constitution of India.',
    defaultGreeting: 'Wishing you a very Happy Republic Day! Proud to celebrate the spirit of India.',
  },
  {
    name: 'Maha Shivratri',
    date: '2025-02-26',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Auspicious night dedicated to Lord Shiva.',
    defaultGreeting: 'May the divine blessings of Lord Shiva bring peace, happiness, and prosperity to your life.',
  },
  {
    name: 'Holi (Festival of Colors)',
    date: '2025-03-14',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Festival of colors, joy, and the arrival of spring.',
    defaultGreeting: 'Wishing you a colorful, vibrant, and joyous Holi filled with happiness and sweet moments!',
  },
  {
    name: 'Ugadi / Gudi Padwa',
    date: '2025-03-30',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Telugu, Kannada, and Marathi New Year.',
    defaultGreeting: 'Wishing you a joyful and prosperous Ugadi / Gudi Padwa! May the new year bring new opportunities.',
  },
  {
    name: 'Eid-ul-Fitr (Ramzan Eid)',
    date: '2025-03-31',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Celebration marking the conclusion of the holy month of Ramadan.',
    defaultGreeting: 'Eid Mubarak! May this joyous day bring peace, good health, and abundant blessings.',
  },
  {
    name: 'Rama Navami',
    date: '2025-04-06',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Birth celebration of Lord Rama.',
    defaultGreeting: 'Happy Rama Navami! May the divine virtues of Lord Rama inspire your life with joy and wisdom.',
  },
  {
    name: 'Good Friday',
    date: '2025-04-18',
    category: 'CHRISTIAN',
    type: 'GAZETTED',
    description: 'Commemoration of the Passion and Crucifixion of Jesus Christ.',
    defaultGreeting: 'Wishing you a peaceful and blessed Good Friday filled with grace and hope.',
  },
  {
    name: 'Easter Sunday',
    date: '2025-04-20',
    category: 'CHRISTIAN',
    type: 'FESTIVAL',
    description: 'Celebration of the resurrection of Jesus Christ.',
    defaultGreeting: 'Happy Easter! Wishing you and your loved ones renewed joy, hope, and peace.',
  },
  {
    name: 'May Day / Labor Day',
    date: '2025-05-01',
    category: 'ALL',
    type: 'RESTRICTED',
    description: 'Honoring workers and labor movements worldwide.',
    defaultGreeting: 'Happy May Day! Celebrating the hard work and dedication of all working professionals.',
  },
  {
    name: 'Eid-ul-Adha (Bakrid)',
    date: '2025-06-07',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Feast of Sacrifice and devotion.',
    defaultGreeting: 'Eid-ul-Adha Mubarak! May your sacrifices be appreciated and your prayers answered.',
  },
  {
    name: 'Independence Day',
    date: '2025-08-15',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'Commemoration of India’s independence on August 15, 1947.',
    defaultGreeting: 'Happy Independence Day! Let us salute the nation and work together for a brighter future.',
  },
  {
    name: 'Raksha Bandhan',
    date: '2025-08-09',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of love and lifelong protection between siblings.',
    defaultGreeting: 'Happy Raksha Bandhan! Wishing you enduring bonds of love, joy, and protection.',
  },
  {
    name: 'Krishna Janmashtami',
    date: '2025-08-16',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of the birth of Lord Krishna.',
    defaultGreeting: 'Happy Krishna Janmashtami! May Lord Krishna bless your business and home with prosperity.',
  },
  {
    name: 'Ganesh Chaturthi',
    date: '2025-08-27',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Grand festival welcoming Lord Ganesha, remover of obstacles.',
    defaultGreeting: 'Happy Ganesh Chaturthi! May Lord Ganesha remove all obstacles and shower success upon you.',
  },
  {
    name: 'Gandhi Jayanti',
    date: '2025-10-02',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'Birth anniversary of Mahatma Gandhi.',
    defaultGreeting: 'Remembering the teachings of truth and non-violence on Gandhi Jayanti.',
  },
  {
    name: 'Dussehra / Vijayadashami',
    date: '2025-10-02',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Triumph of righteousness over evil.',
    defaultGreeting: 'Happy Dussehra! May this auspicious day mark the victory of success, joy, and good health.',
  },
  {
    name: 'Diwali (Deepavali)',
    date: '2025-10-20',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Grand Festival of Lights, wealth, and prosperity.',
    defaultGreeting: 'Wishing you a joyful and sparkling Diwali! May Goddess Lakshmi bless you with endless growth and prosperity.',
  },
  {
    name: 'Guru Nanak Jayanti',
    date: '2025-11-05',
    category: 'OTHER',
    type: 'GAZETTED',
    description: 'Birth anniversary of Guru Nanak Dev Ji, founder of Sikhism.',
    defaultGreeting: 'Happy Gurpurab! May the teachings of Guru Nanak Dev Ji inspire peace, unity, and kindness.',
  },
  {
    name: 'Christmas',
    date: '2025-12-25',
    category: 'CHRISTIAN',
    type: 'GAZETTED',
    description: 'Celebration of the birth of Jesus Christ.',
    defaultGreeting: 'Merry Christmas! May your festive season be filled with warmth, cheer, and peace.',
  },

  // --- 2026 ---
  {
    name: "New Year's Day",
    date: '2026-01-01',
    category: 'ALL',
    type: 'GAZETTED',
    description: 'Welcoming the year 2026.',
    defaultGreeting: 'Wishing you and your family a very Happy and Prosperous New Year 2026!',
  },
  {
    name: 'Makar Sankranti / Pongal / Lohri',
    date: '2026-01-14',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Harvest festival celebrated across India.',
    defaultGreeting: 'Warm greetings on Makar Sankranti and Pongal! Wishing you joyful festivities and great harvest.',
  },
  {
    name: 'Guru Gobind Singh Jayanti',
    date: '2026-01-05',
    category: 'OTHER',
    type: 'RESTRICTED',
    description: 'Birth anniversary of 10th Sikh Guru.',
    defaultGreeting: 'Hearty greetings on Guru Gobind Singh Jayanti. May his courage and wisdom guide us.',
  },
  {
    name: 'Vasant Panchami / Saraswati Puja',
    date: '2026-01-23',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of spring and reverence to Goddess Saraswati.',
    defaultGreeting: 'Happy Vasant Panchami! May Goddess Saraswati bestow knowledge, wisdom, and light.',
  },
  {
    name: 'Republic Day',
    date: '2026-01-26',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'National Day celebrating India’s democratic Constitution.',
    defaultGreeting: 'Wishing you a very Happy Republic Day! Proud to celebrate the pride and unity of India.',
  },
  {
    name: 'Maha Shivratri',
    date: '2026-02-15',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Night of Lord Shiva and spiritual renewal.',
    defaultGreeting: 'Happy Maha Shivratri! May Lord Shiva bless you with inner strength, peace, and good health.',
  },
  {
    name: 'Ramadan (Holy Month Starts)',
    date: '2026-02-18',
    category: 'MUSLIM',
    type: 'FESTIVAL',
    description: 'Commencement of the holy month of fasting and prayers.',
    defaultGreeting: 'Ramadan Mubarak! May this sacred month bring peace, health, and abundant blessings.',
  },
  {
    name: 'Holi (Festival of Colors)',
    date: '2026-03-04',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Joyous spring festival of colors, music, and love.',
    defaultGreeting: 'Wishing you and your family a vibrant, safe, and joyful Holi filled with sweet moments!',
  },
  {
    name: 'Ugadi / Gudi Padwa',
    date: '2026-03-19',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Telugu, Kannada, and Marathi New Year.',
    defaultGreeting: 'Wishing you a joyous and blessed Ugadi / Gudi Padwa! May this new year bring wealth and happiness.',
  },
  {
    name: 'Eid-ul-Fitr (Ramzan Eid)',
    date: '2026-03-20',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Celebration marking the conclusion of Ramadan.',
    defaultGreeting: 'Eid Mubarak! Wishing you and your family a joyous Eid filled with peace and prosperity.',
  },
  {
    name: 'Rama Navami',
    date: '2026-03-27',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of the birth of Lord Rama.',
    defaultGreeting: 'Happy Rama Navami! May the divine blessings of Lord Rama bring harmony and prosperity to your life.',
  },
  {
    name: 'Mahavir Jayanti',
    date: '2026-03-31',
    category: 'OTHER',
    type: 'GAZETTED',
    description: 'Birth anniversary of Lord Mahavira.',
    defaultGreeting: 'Happy Mahavir Jayanti! May the ideals of peace, compassion, and non-violence guide us always.',
  },
  {
    name: 'Good Friday',
    date: '2026-04-03',
    category: 'CHRISTIAN',
    type: 'GAZETTED',
    description: 'Solemn Christian holy day commemorating the Crucifixion.',
    defaultGreeting: 'Wishing you a peaceful, reflective, and blessed Good Friday.',
  },
  {
    name: 'Easter Sunday',
    date: '2026-04-05',
    category: 'CHRISTIAN',
    type: 'FESTIVAL',
    description: 'Celebration of the resurrection of Jesus Christ.',
    defaultGreeting: 'Happy Easter! May the spirit of Easter bring hope, love, and joyful new beginnings.',
  },
  {
    name: 'Baisakhi / Vishu / Puthandu',
    date: '2026-04-14',
    category: 'ALL',
    type: 'FESTIVAL',
    description: 'Harvest festival and regional traditional new year.',
    defaultGreeting: 'Happy Baisakhi, Vishu & Puthandu! May this harvest season fill your home with wealth and joy.',
  },
  {
    name: 'Dr. B.R. Ambedkar Jayanti',
    date: '2026-04-14',
    category: 'ALL',
    type: 'GAZETTED',
    description: 'Birth anniversary of Dr. B.R. Ambedkar.',
    defaultGreeting: 'Tributes to Babasaheb Dr. B.R. Ambedkar on his Jayanti. Honoring equality and justice.',
  },
  {
    name: 'Akshaya Tritiya',
    date: '2026-04-20',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Auspicious day for prosperity, new ventures, and gold purchases.',
    defaultGreeting: 'Happy Akshaya Tritiya! May this auspicious day bring unending fortune and eternal success.',
  },
  {
    name: 'May Day / Labor Day',
    date: '2026-05-01',
    category: 'ALL',
    type: 'RESTRICTED',
    description: 'Celebrating the contribution of workers.',
    defaultGreeting: 'Happy International Workers Day! Saluting the diligence of workers everywhere.',
  },
  {
    name: 'Buddha Purnima',
    date: '2026-05-01',
    category: 'OTHER',
    type: 'GAZETTED',
    description: 'Birth and enlightenment of Gautama Buddha.',
    defaultGreeting: 'Happy Buddha Purnima! May the noble teachings of Lord Buddha bring serenity and wisdom.',
  },
  {
    name: 'Eid-ul-Adha (Bakrid)',
    date: '2026-05-27',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Feast of the Sacrifice observed by Muslims worldwide.',
    defaultGreeting: 'Eid-ul-Adha Mubarak! May your prayers be accepted and your home blessed with harmony.',
  },
  {
    name: 'Muharram (Ashura)',
    date: '2026-06-26',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'First month of the Islamic lunar calendar.',
    defaultGreeting: 'Wishing you a peaceful and blessed Muharram filled with reflection and fortitude.',
  },
  {
    name: 'Guru Purnima',
    date: '2026-07-29',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Day dedicated to expressing gratitude to spiritual and academic mentors.',
    defaultGreeting: 'Happy Guru Purnima! Expressing heartfelt gratitude to all our mentors and guides.',
  },
  {
    name: 'Independence Day',
    date: '2026-08-15',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'Celebration of India’s 80th Independence Day.',
    defaultGreeting: 'Wishing you a proud and Happy Independence Day! Let us celebrate the progress and glory of our nation.',
  },
  {
    name: 'Milad-un-Nabi (Eid-e-Milad)',
    date: '2026-08-26',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Observance of the birthday of the Prophet Muhammad.',
    defaultGreeting: 'Milad-un-Nabi Mubarak! May peace and divine mercy be upon you and your family.',
  },
  {
    name: 'Raksha Bandhan',
    date: '2026-08-28',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of the sacred bond between brothers and sisters.',
    defaultGreeting: 'Happy Raksha Bandhan! Wishing you cherished memories and strong bonds of love and protection.',
  },
  {
    name: 'Krishna Janmashtami',
    date: '2026-09-04',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebration of the birth of Lord Krishna.',
    defaultGreeting: 'Happy Janmashtami! May Lord Krishna bless your business and family with joy, peace, and abundance.',
  },
  {
    name: 'Onam (Thiruvonam)',
    date: '2026-09-04',
    category: 'ALL',
    type: 'FESTIVAL',
    description: 'Grand harvest and cultural festival of Kerala.',
    defaultGreeting: 'Happy Onam! May the spirit of King Mahabali bring happiness, health, and prosperity to your home.',
  },
  {
    name: 'Ganesh Chaturthi',
    date: '2026-09-14',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Welcoming Lord Ganesha with grand devotion.',
    defaultGreeting: 'Happy Ganesh Chaturthi! May Lord Vighnaharta bestow good fortune, wisdom, and remove all obstacles.',
  },
  {
    name: 'Gandhi Jayanti',
    date: '2026-10-02',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'Honoring Mahatma Gandhi on his birth anniversary.',
    defaultGreeting: 'Warm tributes on Gandhi Jayanti. May truth, peace, and harmony guide our nation.',
  },
  {
    name: 'Navratri Begins (Ghatasthapana)',
    date: '2026-10-11',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Start of the auspicious 9-night celebration of Goddess Durga.',
    defaultGreeting: 'Shubh Navratri! May Maa Durga empower you with strength, prosperity, and happiness.',
  },
  {
    name: 'Ayudha Pooja / Maha Navami',
    date: '2026-10-20',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Worship of machinery, vehicles, and tools of trade.',
    defaultGreeting: 'Happy Ayudha Pooja! May the tools of our trade and industry yield boundless success and growth.',
  },
  {
    name: 'Dussehra / Vijayadashami',
    date: '2026-10-21',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Victory of truth over falsehood and good over evil.',
    defaultGreeting: 'Happy Dussehra / Vijayadashami! May this day bring victory, prosperity, and new triumphs in your journey.',
  },
  {
    name: 'Karwa Chauth',
    date: '2026-10-29',
    category: 'HINDU',
    type: 'RESTRICTED',
    description: 'Fasting day observed for longevity and happiness.',
    defaultGreeting: 'Happy Karwa Chauth! Wishing all couples lifelong love, trust, and happiness.',
  },
  {
    name: 'Dhanteras',
    date: '2026-11-06',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Worship of Lord Dhanvantari and Goddess Lakshmi; auspicious for wealth.',
    defaultGreeting: 'Happy Dhanteras! May Lord Dhanvantari bless you with vibrant health and timeless wealth.',
  },
  {
    name: 'Diwali (Deepavali / Lakshmi Puja)',
    date: '2026-11-08',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Grand Festival of Lights, lamps, sweets, and prosperity.',
    defaultGreeting: 'Wishing you and your family a very Happy and Prosperous Diwali! May your home be blessed with immense light and wealth.',
  },
  {
    name: 'Bhai Dooj',
    date: '2026-11-10',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Celebrating the bond between brothers and sisters.',
    defaultGreeting: 'Happy Bhai Dooj! Wishing joy and affection to all siblings.',
  },
  {
    name: 'Chhath Puja',
    date: '2026-11-15',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Worship of the Sun God (Surya Dev) and Chhathi Maiya.',
    defaultGreeting: 'Happy Chhath Puja! May Surya Dev illuminate your path with vitality, health, and glory.',
  },
  {
    name: 'Guru Nanak Jayanti',
    date: '2026-11-24',
    category: 'OTHER',
    type: 'GAZETTED',
    description: 'Birth anniversary of Guru Nanak Dev Ji.',
    defaultGreeting: 'Happy Gurpurab! May Guru Nanak Dev Ji’s blessings bring tranquility and prosperity to your life.',
  },
  {
    name: 'Christmas Eve',
    date: '2026-12-24',
    category: 'CHRISTIAN',
    type: 'RESTRICTED',
    description: 'Eve of the celebration of the Nativity.',
    defaultGreeting: 'Warm Christmas Eve wishes to you and your family! Have a cozy and cheerful celebration.',
  },
  {
    name: 'Christmas Day',
    date: '2026-12-25',
    category: 'CHRISTIAN',
    type: 'GAZETTED',
    description: 'Christmas celebration of peace, joy, and goodwill.',
    defaultGreeting: 'Merry Christmas! May this holy season bring peace, joy, and good tidings to your home.',
  },
  {
    name: "New Year's Eve",
    date: '2026-12-31',
    category: 'ALL',
    type: 'FESTIVAL',
    description: 'Celebrating the conclusion of 2026 and welcoming the new year.',
    defaultGreeting: 'Happy New Year’s Eve! Thank you for a wonderful year of partnership and growth.',
  },

  // --- 2027 ---
  {
    name: "New Year's Day",
    date: '2027-01-01',
    category: 'ALL',
    type: 'GAZETTED',
    description: 'First day of 2027.',
    defaultGreeting: 'Happy New Year 2027! Wishing you abundant success and new milestones.',
  },
  {
    name: 'Makar Sankranti / Pongal',
    date: '2027-01-14',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Harvest festivities.',
    defaultGreeting: 'Happy Makar Sankranti and Pongal! May your life be filled with sweetness and prosperity.',
  },
  {
    name: 'Republic Day',
    date: '2027-01-26',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'National Day of the Indian Republic.',
    defaultGreeting: 'Happy Republic Day! Proud to celebrate India’s unity, strength, and heritage.',
  },
  {
    name: 'Maha Shivratri',
    date: '2027-03-06',
    category: 'HINDU',
    type: 'FESTIVAL',
    description: 'Holy night of Lord Shiva.',
    defaultGreeting: 'Happy Maha Shivratri! May Lord Shiva bless you with peace and prosperity.',
  },
  {
    name: 'Eid-ul-Fitr',
    date: '2027-03-10',
    category: 'MUSLIM',
    type: 'GAZETTED',
    description: 'Conclusion of Ramadan.',
    defaultGreeting: 'Eid Mubarak! Wishing you and your family happiness and harmony.',
  },
  {
    name: 'Holi',
    date: '2027-03-23',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Festival of colors and spring.',
    defaultGreeting: 'Wishing you a joyful, vibrant, and safe Holi!',
  },
  {
    name: 'Independence Day',
    date: '2027-08-15',
    category: 'ALL',
    type: 'NATIONAL_HOLIDAY',
    description: 'India Independence Day.',
    defaultGreeting: 'Happy Independence Day! Saluting the spirit of freedom and unity.',
  },
  {
    name: 'Ganesh Chaturthi',
    date: '2027-09-04',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Lord Ganesha arrival festival.',
    defaultGreeting: 'Happy Ganesh Chaturthi! May Lord Ganesha bestow good fortune and wisdom upon you.',
  },
  {
    name: 'Diwali',
    date: '2027-10-29',
    category: 'HINDU',
    type: 'GAZETTED',
    description: 'Grand Festival of Lights.',
    defaultGreeting: 'Wishing you a very Happy and Prosperous Diwali!',
  },
  {
    name: 'Christmas',
    date: '2027-12-25',
    category: 'CHRISTIAN',
    type: 'GAZETTED',
    description: 'Celebration of Christmas.',
    defaultGreeting: 'Merry Christmas! May your days be merry, bright, and blessed.',
  },
];

// Helper to assign deterministic IDs
export const FESTIVALS: FestivalItem[] = FESTIVAL_DATABASE.map((f, idx) => ({
  ...f,
  id: `fest-${f.date}-${idx}`,
}));

export const FESTIVAL_TYPE_LABELS: Record<FestivalType, { label: string; badgeVariant: 'default' | 'secondary' | 'outline' | 'destructive' }> = {
  NATIONAL_HOLIDAY: { label: 'National Holiday', badgeVariant: 'destructive' },
  GAZETTED: { label: 'Gazetted Holiday', badgeVariant: 'default' },
  FESTIVAL: { label: 'Major Festival', badgeVariant: 'secondary' },
  RESTRICTED: { label: 'Observance', badgeVariant: 'outline' },
};

/**
 * Normalizes date to start-of-day timestamp
 */
export function toDayStart(d: Date | string): number {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c.getTime();
}

/**
 * Calculates number of days from reference date to festival date.
 * (0 = today, 1 = tomorrow, -1 = yesterday, >0 = future)
 */
export function getDaysUntilFestival(festivalDateStr: string, refDate: Date = new Date()): number {
  const festTime = toDayStart(festivalDateStr);
  const refTime = toDayStart(refDate);
  return Math.round((festTime - refTime) / 86400000);
}

/**
 * Human readable status string (e.g. "Today 🎉", "Tomorrow", "In 3 days", "Passed")
 */
export function getFestivalStatusLabel(festivalDateStr: string, refDate: Date = new Date()): {
  text: string;
  isToday: boolean;
  isTomorrow: boolean;
  isUpcoming: boolean;
  days: number;
} {
  const days = getDaysUntilFestival(festivalDateStr, refDate);
  if (days === 0) return { text: 'Today 🎉', isToday: true, isTomorrow: false, isUpcoming: false, days };
  if (days === 1) return { text: 'Tomorrow', isToday: false, isTomorrow: true, isUpcoming: true, days };
  if (days === 2) return { text: 'In 2 days', isToday: false, isTomorrow: false, isUpcoming: true, days };
  if (days > 2 && days <= 30) return { text: `In ${days} days`, isToday: false, isTomorrow: false, isUpcoming: true, days };
  if (days > 30) return { text: `In ${days} days`, isToday: false, isTomorrow: false, isUpcoming: true, days };
  return { text: `${Math.abs(days)}d ago`, isToday: false, isTomorrow: false, isUpcoming: false, days };
}

/**
 * Gets festivals occurring today or in the next `daysAhead` days (default 3 days for alert popups).
 */
export function getUpcomingReminders(refDate: Date = new Date(), daysAhead = 3): (FestivalItem & { daysUntil: number; statusLabel: string })[] {
  return FESTIVALS
    .map((f) => {
      const days = getDaysUntilFestival(f.date, refDate);
      const status = getFestivalStatusLabel(f.date, refDate);
      return { ...f, daysUntil: days, statusLabel: status.text };
    })
    .filter((f) => f.daysUntil >= 0 && f.daysUntil <= daysAhead)
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

/**
 * Gets all upcoming festivals within `daysSpan` (default 60 days) for the calendar widget.
 */
export function getUpcomingFestivalsList(
  refDate: Date = new Date(),
  daysSpan = 60,
  categoryFilter: FestivalCategory = 'ALL'
): (FestivalItem & { daysUntil: number; statusLabel: string })[] {
  return FESTIVALS
    .map((f) => {
      const days = getDaysUntilFestival(f.date, refDate);
      const status = getFestivalStatusLabel(f.date, refDate);
      return { ...f, daysUntil: days, statusLabel: status.text };
    })
    .filter((f) => {
      if (f.daysUntil < 0 || f.daysUntil > daysSpan) return false;
      if (categoryFilter !== 'ALL' && f.category !== 'ALL' && f.category !== categoryFilter) return false;
      return true;
    })
    .sort((a, b) => a.daysUntil - b.daysUntil);
}

/**
 * Gets festivals grouped by month for a given year.
 */
export function getFestivalsForYear(year: number): Record<number, FestivalItem[]> {
  const yearStr = String(year);
  const byMonth: Record<number, FestivalItem[]> = {};
  for (let m = 0; m < 12; m++) byMonth[m] = [];

  FESTIVALS.forEach((f) => {
    if (f.date.startsWith(yearStr)) {
      const monthIdx = new Date(f.date).getMonth();
      if (byMonth[monthIdx]) {
        byMonth[monthIdx].push(f);
      }
    }
  });

  return byMonth;
}
