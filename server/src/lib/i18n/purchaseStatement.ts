export type StatementLanguage = 'en' | 'ta' | 'te' | 'ml' | 'kn';

export interface LanguageOption {
  code: StatementLanguage;
  label: string;
  nativeName: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: LanguageOption[] = [
  { code: 'en', label: 'English', nativeName: 'English', flag: '🇬🇧' },
  { code: 'ta', label: 'Tamil', nativeName: 'தமிழ்', flag: '🇮🇳' },
  { code: 'te', label: 'Telugu', nativeName: 'తెలుగు', flag: '🇮🇳' },
  { code: 'ml', label: 'Malayalam', nativeName: 'മലയാളം', flag: '🇮🇳' },
  { code: 'kn', label: 'Kannada', nativeName: 'ಕನ್ನಡ', flag: '🇮🇳' },
];

export interface TranslationStrings {
  purchaseStatement: string;
  dated: string;
  unloadedAndVerified: string;
  statementFor: string;
  invoiceNo: string;
  vehicle: string;
  purchaseOrder: string;
  partyVehicleNote: string;
  
  // Weighment headers
  invoiceWeight: string;
  partyKata: string;
  rvpKata: string;
  difference: string;
  payableWeight: string;

  // Kata verification explanations
  kataBothAgree: string;
  kataRvpHeavier: (rvpNet: string) => string;
  kataWithinAllowance: (diff: string, allowance: number) => string;
  kataExceedsAllowance: (diff: string, allowance: number, deducted: string) => string;

  // Table headers
  particulars: string;
  quantity: string;
  ratePerKg: string;
  amountInr: string;

  // Line item labels & notes
  lessKataDiff: string;
  kataDiffNote: (short: string, ref: string, allowance: number) => string;
  netSeedValue: string;
  addIgst: string;
  igstNote: (billingKg: string, price: string) => string;
  lessHamali: string;
  hamaliNote: string;
  lessKataCharges: string;
  kataChargesNote: string;
  lessQualityCut: (modeName: string) => string;

  // Net payable & footer
  netBalancePayable: string;
  computerGeneratedNote: string;
  forCompany: (companyName: string) => string;
  authorisedSignatory: string;
}

export const TRANSLATIONS: Record<StatementLanguage, TranslationStrings> = {
  en: {
    purchaseStatement: 'PURCHASE STATEMENT',
    dated: 'Dated',
    unloadedAndVerified: 'Unloaded & weight-verified',
    statementFor: 'STATEMENT FOR',
    invoiceNo: 'Invoice No.',
    vehicle: 'Vehicle',
    purchaseOrder: 'Purchase Order',
    partyVehicleNote: '(party vehicle)',

    invoiceWeight: 'INVOICE WEIGHT',
    partyKata: 'PARTY KATA',
    rvpKata: 'RVP KATA',
    difference: 'DIFFERENCE',
    payableWeight: 'PAYABLE WEIGHT',

    kataBothAgree: 'Both weighbridges agree - payable at the full reference weight.',
    kataRvpHeavier: (rvpNet) => `RVP weighbridge read heavier than the party kata - paid on our higher net of ${rvpNet}.`,
    kataWithinAllowance: (diff, allowance) => `Difference of ${diff} is within the ${allowance} kg free allowance - no weight deduction.`,
    kataExceedsAllowance: (diff, allowance, deducted) => `Difference of ${diff} exceeds the ${allowance} kg free allowance - ${deducted} deducted below.`,

    particulars: 'PARTICULARS',
    quantity: 'QUANTITY',
    ratePerKg: 'RATE / KG',
    amountInr: 'AMOUNT (INR)',

    lessKataDiff: 'Less : Kata difference',
    kataDiffNote: (short, ref, allowance) => `${short} short against ${ref} reference, ${allowance} kg allowed free`,
    netSeedValue: 'Net seed value',
    addIgst: 'Add : IGST @ 5%',
    igstNote: (billingKg, price) => `on invoice value ${billingKg} × ${price}`,
    lessHamali: 'Less : Hamali (unloading)',
    hamaliNote: "lorry's share recovered - party's own vehicle",
    lessKataCharges: 'Less : Kata charges (weighbridge)',
    kataChargesNote: "recovered - party's own vehicle",
    lessQualityCut: (label) => `Less : ${label}`,

    netBalancePayable: 'NET BALANCE PAYABLE',
    computerGeneratedNote: 'Computer-generated statement. Please report any discrepancy within 7 days of receipt.',
    forCompany: (company) => `for ${company}`,
    authorisedSignatory: 'Authorised Signatory',
  },

  ta: {
    purchaseStatement: 'கொள்முதல் அறிக்கை (PURCHASE STATEMENT)',
    dated: 'தேதி',
    unloadedAndVerified: 'சரக்கு இறக்கப்பட்டு எடை சரிபார்க்கப்பட்டது',
    statementFor: 'அறிக்கை பெறுபவர்',
    invoiceNo: 'இன்வாய்ஸ் எண்',
    vehicle: 'வாகனம்',
    purchaseOrder: 'கொள்முதல் ஆர்டர்',
    partyVehicleNote: '(சொந்த வாகனம்)',

    invoiceWeight: 'இன்வாய்ஸ் எடை',
    partyKata: 'பார்ட்டி காடா',
    rvpKata: 'RVP காடா',
    difference: 'எடை வித்தியாசம்',
    payableWeight: 'பணமளிக்கும் எடை',

    kataBothAgree: 'இரு எடை மேடைகளும் சமமாக உள்ளது - முழு எடைக் கணக்கீட்டின்படி பணமளிக்கப்படும்.',
    kataRvpHeavier: (rvpNet) => `RVP எடை பார்ட்டி எடையை விட அதிகமாக உள்ளது - அதிகமான எடையான ${rvpNet} க்கு பணமளிக்கப்படுகிறது.`,
    kataWithinAllowance: (diff, allowance) => `${diff} வித்தியாசம் அனுமதித்த ${allowance} கிலோ வரம்பிற்குள் உள்ளது - எடை கழிவு இல்லை.`,
    kataExceedsAllowance: (diff, allowance, deducted) => `${diff} வித்தியாசம் அனுமதித்த ${allowance} கிலோவை விட அதிகமாக உள்ளது - ${deducted} கீழே கழிக்கப்பட்டுள்ளது.`,

    particulars: 'விவரங்கள் (PARTICULARS)',
    quantity: 'அளவு',
    ratePerKg: 'விலை / KG',
    amountInr: 'தொகை (INR)',

    lessKataDiff: 'கழிக்க : காடா எடை வித்தியாசம்',
    kataDiffNote: (short, ref, allowance) => `${ref} எடையில் ${short} குறைவு, ${allowance} kg இலவச அனுமதி`,
    netSeedValue: 'நிகர விதை மதிப்பு',
    addIgst: 'சேர்க்க : IGST @ 5%',
    igstNote: (billingKg, price) => `இன்வாய்ஸ் மதிப்பு ${billingKg} × ${price}`,
    lessHamali: 'கழிக்க : ஹமாலி (இறக்கு கூலி)',
    hamaliNote: 'லாரி பங்கு பிடித்தம் - சொந்த வாகனம்',
    lessKataCharges: 'கழிக்க : காடா கட்டணம்',
    kataChargesNote: 'பிடித்தம் செய்யப்பட்டது - சொந்த வாகனம்',
    lessQualityCut: (label) => `கழிக்க : தரக் கழிவு (${label})`,

    netBalancePayable: 'நிகர செலுத்த வேண்டிய தொகை',
    computerGeneratedNote: 'இது கணினி மூலம் உருவாக்கப்பட்ட அறிக்கை. ஏதேனும் முரண்பாடுகள் இருந்தால் 7 நாட்களுக்குள் தெரிவிக்கவும்.',
    forCompany: (company) => `${company} சார்பாக`,
    authorisedSignatory: 'அதிகாரப்பூர்வ கையொப்பமிட்டவர்',
  },

  te: {
    purchaseStatement: 'కొనుగోలు నివేదిక (PURCHASE STATEMENT)',
    dated: 'తేదీ',
    unloadedAndVerified: 'సరుకు దించబడింది & బరువు సరిచూడబడింది',
    statementFor: 'నివేదిక గ్రహీత',
    invoiceNo: 'ఇన్‌వాయిస్ నం.',
    vehicle: 'వాహనం',
    purchaseOrder: 'కొనుగోలు ఆర్డర్',
    partyVehicleNote: '(సొంత వాహనం)',

    invoiceWeight: 'ఇన్‌వాయిస్ బరువు',
    partyKata: 'పార్టీ కాటా',
    rvpKata: 'RVP కాటా',
    difference: 'బరువు తేడా',
    payableWeight: 'చెల్లించదగిన బరువు',

    kataBothAgree: 'రెండు వేబ్రిడ్జిలు సరిపోయాయి - పూర్తి బరువుకు చెల్లించబడుతుంది.',
    kataRvpHeavier: (rvpNet) => `RVP కాటా బరువు పార్టీ కాటా కంటే ఎక్కువగా ఉంది - ఎక్కువ బరువైన ${rvpNet} పై చెల్లించబడింది.`,
    kataWithinAllowance: (diff, allowance) => `${diff} తేడా అనుమతించిన ${allowance} కిలోల ఉచిత పరిమితిలో ఉంది - బరువు తగ్గింపు లేదు.`,
    kataExceedsAllowance: (diff, allowance, deducted) => `${diff} తేడా అనుమతించిన ${allowance} కిలోల పరిమితిని మించింది - ${deducted} కింద తగ్గించబడింది.`,

    particulars: 'వివరాలు (PARTICULARS)',
    quantity: 'పరిమాణం',
    ratePerKg: 'ధర / KG',
    amountInr: 'మొత్తం (INR)',

    lessKataDiff: 'తీసివేయండి : కాటా తేడా',
    kataDiffNote: (short, ref, allowance) => `${ref} బరువులో ${short} తక్కువ, ${allowance} kg ఉచిత అనుమతి`,
    netSeedValue: 'నికర విత్తనాల విలువ',
    addIgst: 'కలపండి : IGST @ 5%',
    igstNote: (billingKg, price) => `ఇన్‌వాయిస్ విలువ ${billingKg} × ${price}`,
    lessHamali: 'తీసివేయండి : హమాలి (దిగుమతి కూలీ)',
    hamaliNote: 'లారీ వాటా రికవరీ - సొంత వాహనం',
    lessKataCharges: 'తీసివేయండి : కాటా ఛార్జీలు',
    kataChargesNote: 'రికవరీ - సొంత వాహనం',
    lessQualityCut: (label) => `తీసివేయండి : క్వాలిటీ కోత (${label})`,

    netBalancePayable: 'నికర చెల్లించవలసిన బకాయి',
    computerGeneratedNote: 'ఇది కంప్యూటర్ ద్వారా రూపొందించబడిన నివేదిక. ఏవైనా తేడాలు ఉంటే 7 రోజులలోపు తెలియజేయండి.',
    forCompany: (company) => `${company} తరఫున`,
    authorisedSignatory: 'అధీకృత సంతకం',
  },

  ml: {
    purchaseStatement: 'വാങ്ങൽ പ്രസ്താവന (PURCHASE STATEMENT)',
    dated: 'തീയതി',
    unloadedAndVerified: 'സാധനം ഇറക്കി ഭാരം പരിശോധിച്ചു',
    statementFor: 'വിലാസക്കാരൻ',
    invoiceNo: 'ഇൻവോയ്സ് നമ്പർ',
    vehicle: 'വാഹനം',
    purchaseOrder: 'പർച്ചേസ് ഓർഡർ',
    partyVehicleNote: '(സ്വന്തം വാഹനം)',

    invoiceWeight: 'ഇൻവോയ്സ് ഭാരം',
    partyKata: 'പാർട്ടി കോട്ട (കാട്ട)',
    rvpKata: 'RVP കോട്ട (കാട്ട)',
    difference: 'ഭാര വ്യത്യാസം',
    payableWeight: 'നൽകേണ്ട ഭാരം',

    kataBothAgree: 'രണ്ട് വെയ്‌ബ്രിഡ്ജുകളും തുല്യമാണ് - പൂർണ്ണ ഭാരത്തിന് തുക നൽകും.',
    kataRvpHeavier: (rvpNet) => `RVP കാട്ട ഭാരം പാർട്ടി കാട്ടയേக்காൾ കൂടുതലാണ് - കൂടുതൽ ഭാരമായ ${rvpNet} ന് തുക നൽകുന്നു.`,
    kataWithinAllowance: (diff, allowance) => `${diff} വ്യത്യാസം അനുവദിച്ച ${allowance} കിലോ പരിധിക്കുള്ളിലാണ് - ഭാരം കുറയ്ക്കില്ല.`,
    kataExceedsAllowance: (diff, allowance, deducted) => `${diff} വ്യത്യാസം ${allowance} കിലോ പരിധിയേക്കാൾ കൂടുതലാണ് - ${deducted} താഴെ കുറച്ചിരിക്കുന്നു.`,

    particulars: 'വിവരങ്ങൾ (PARTICULARS)',
    quantity: 'അളവ്',
    ratePerKg: 'നിരക്ക് / KG',
    amountInr: 'തുക (INR)',

    lessKataDiff: 'കുറയ്ക്കുക : കാട്ട വ്യത്യാസം',
    kataDiffNote: (short, ref, allowance) => `${ref} ഭാരത്തിൽ ${short} കുറവ്, ${allowance} kg സൗജന്യം`,
    netSeedValue: 'അറ്റ വിത്ത് മൂല്യം',
    addIgst: 'കൂട്ടുക : IGST @ 5%',
    igstNote: (billingKg, price) => `ഇൻവോയ്സ് തുക ${billingKg} × ${price}`,
    lessHamali: 'കുറയ്ക്കുക : ഹമാലി (ഇറക്ക കൂലി)',
    hamaliNote: 'ലോറി വിഹിതം പിടിച്ചു - സ്വന്തം വാഹനം',
    lessKataCharges: 'കുറയ്ക്കുക : കാട്ട ചാർജ്ജ്',
    kataChargesNote: 'പിടിച്ചെടുത്തത് - സ്വന്തം വാഹനം',
    lessQualityCut: (label) => `കുറയ്ക്കുക : ക്വാളിറ്റി കുറവ് (${label})`,

    netBalancePayable: 'ആകെ നൽകേണ്ട കുടിശ്ശിക തുക',
    computerGeneratedNote: 'ഇത് കമ്പ്യൂട്ടർ വഴി തയ്യാറാക്കിയ പ്രസ്താവനയാണ്. എന്തെങ്കിലും തെറ്റുകളുണ്ടെങ്കിൽ 7 ദിവസത്തിനകം അറിയിക്കുക.',
    forCompany: (company) => `${company} ക്ക് വേണ്ടി`,
    authorisedSignatory: 'അധികാരപ്പെടുത്തിയ ഒപ്പ്',
  },

  kn: {
    purchaseStatement: 'ಖರೀದಿ ವಿವರಣೆ (PURCHASE STATEMENT)',
    dated: 'ದಿನಾಂಕ',
    unloadedAndVerified: 'ಅನ್‌ಲೋಡ್ ಮಾಡಿ ತೂಕ ಪರಿಶೀಲಿಸಲಾಗಿದೆ',
    statementFor: 'ವಿವರಣೆ ಸ್ವೀಕರಿಸುವವರು',
    invoiceNo: 'ಇನ್‌ವಾಯ್ಸ್ ಸಂಖ್ಯೆ',
    vehicle: 'ವಾಹನ',
    purchaseOrder: 'ಖರೀದಿ ಆದೇಶ',
    partyVehicleNote: '(ಸ್ವಂತ ವಾಹನ)',

    invoiceWeight: 'ಇನ್‌ವಾಯ್ಸ್ ತೂಕ',
    partyKata: 'ಪಾರ್ಟಿ ಕಾಟಾ',
    rvpKata: 'RVP ಕಾಟಾ',
    difference: 'ತೂಕದ ವ್ಯತ್ಯಾಸ',
    payableWeight: 'ಪಾವತಿಸಬೇಕಾದ ತೂಕ',

    kataBothAgree: 'ಎರಡೂ ವೇಬ್ರಿಡ್ಜ್‌ಗಳು ಸಮನಾಗಿವೆ - ಪೂರ್ಣ ತೂಕಕ್ಕೆ ಪಾವತಿಸಲಾಗುವುದು.',
    kataRvpHeavier: (rvpNet) => `RVP ಕಾಟಾ ತೂಕವು ಪಾರ್ಟಿ ಕಾಟಾಗಿಂತ ಹೆಚ್ಚಾಗಿದೆ - ಹೆಚ್ಚಿನ ತೂಕ ${rvpNet} ಗೆ ಪಾವತಿಸಲಾಗಿದೆ.`,
    kataWithinAllowance: (diff, allowance) => `${diff} ವ್ಯತ್ಯಾಸವು ಉಚಿತ ${allowance} ಕೆಜಿ ಮಿತಿಯೊಳಗಿದೆ - ತೂಕ ಕಡಿತವಿಲ್ಲ.`,
    kataExceedsAllowance: (diff, allowance, deducted) => `${diff} ವ್ಯತ್ಯಾಸವು ${allowance} ಕೆಜಿ ಉಚಿತ ಮಿತಿಯನ್ನು ಮೀರಿದೆ - ${deducted} ಕೆಳಗೆ ಕಡಿತಗೊಳಿಸಲಾಗಿದೆ.`,

    particulars: 'ವಿವರಗಳು (PARTICULARS)',
    quantity: 'ಪ್ರಮಾಣ',
    ratePerKg: 'ದರ / KG',
    amountInr: 'ಮೊತ್ತ (INR)',

    lessKataDiff: 'ಕಳೆಯಿರಿ : ಕಾಟಾ ವ್ಯತ್ಯಾಸ',
    kataDiffNote: (short, ref, allowance) => `${ref} ತೂಕದಲ್ಲಿ ${short} ಕೊರತೆ, ${allowance} kg ಉಚಿತ ಮಿತಿ`,
    netSeedValue: 'ನಿವ್ವಳ ಬೀಜದ ಮೌಲ್ಯ',
    addIgst: 'ಸೇರಿಸಿ : IGST @ 5%',
    igstNote: (billingKg, price) => `ಇನ್‌ವಾಯ್ಸ್ ಮೌಲ್ಯ ${billingKg} × ${price}`,
    lessHamali: 'ಕಳೆಯಿರಿ : ಹಮಾಲಿ (ಅನ್‌ಲೋಡಿಂಗ್)',
    hamaliNote: 'ಲಾರಿ ಪಾಲು ಹಿಡಿಯಲಾಗಿದೆ - ಸ್ವಂತ ವಾಹನ',
    lessKataCharges: 'ಕಳೆಯಿರಿ : ಕಾಟಾ ವೆಚ್ಚಗಳು',
    kataChargesNote: 'ಹಿಡಿಯಲಾಗಿದೆ - ಸ್ವಂತ ವಾಹನ',
    lessQualityCut: (label) => `ಕಳೆಯಿರಿ : ಗುಣಮಟ್ಟದ ಕಡಿತ (${label})`,

    netBalancePayable: 'ನಿವ್ವಳ ಪಾವತಿಸಬೇಕಾದ ಬಾಕಿ',
    computerGeneratedNote: 'ಇದು ಗಣಕಯಂತ್ರ ರಚಿತ ವಿವರಣೆ. ಯಾವುದೇ ವ್ಯತ್ಯಾಸವಿದ್ದರೆ 7 ದಿನಗಳ ಒಳಗೆ ತಿಳಿಸಿ.',
    forCompany: (company) => `${company} ಪರವಾಗಿ`,
    authorisedSignatory: 'ಅಧಿಕೃತ ಸಹಿದಾರರು',
  },
};
