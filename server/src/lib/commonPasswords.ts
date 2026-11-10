/**
 * Local blocklist of commonly used and breach-exposed passwords
 * (plan item 1.2: "block common/breached passwords (local list)").
 *
 * Local on purpose. The alternative is the Have I Been Pwned range API, which
 * would mean an outbound request on the critical path of every password change
 * — a dependency that can be slow or down, and a k-anonymity prefix of the
 * user's password hash leaving the building. For a deployment with a handful of
 * staff accounts, screening the passwords people actually pick is the part that
 * matters.
 *
 * Entries are lowercase and compared against the normalised forms produced by
 * passwordPolicy.ts, which also strips leet substitutions and trailing digits —
 * so `P@ssw0rd123` is caught by the `password` entry here and does not need its
 * own. That is why this list is short and has no padding: each entry covers a
 * family.
 *
 * Nothing shorter than the minimum length needs to be here either; those are
 * already rejected on length. They are kept because the stripped form of a
 * longer password can be short (`monkey123456` normalises to `monkey`).
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  // Perennial top of every breach corpus
  'password', 'passwort', 'pass', 'passwd', 'password1', 'passw0rd',
  '123456', '12345678', '123456789', '1234567890', '111111', '000000',
  'qwerty', 'qwertyuiop', 'qwerty123', 'asdfgh', 'asdfghjkl', 'zxcvbnm',
  'abc123', 'abcdef', 'abcd1234', 'a1b2c3',
  'iloveyou', 'princess', 'sunshine', 'monkey', 'dragon', 'football',
  'baseball', 'basketball', 'superman', 'batman', 'pokemon', 'starwars',
  'letmein', 'welcome', 'login', 'admin', 'administrator', 'root', 'guest',
  'master', 'secret', 'default', 'changeme', 'temp', 'test', 'demo',
  'qazwsx', 'trustno', 'whatever', 'shadow', 'michael', 'jennifer',
  'computer', 'internet', 'samsung', 'google', 'facebook', 'whatsapp',
  'freedom', 'flower', 'hottie', 'loveme', 'zaq', 'jordan', 'harley',
  'ranger', 'buster', 'thomas', 'robert', 'daniel', 'ashley', 'charlie',
  'summer', 'winter', 'spring', 'autumn',
  // Common in Indian breach corpora
  'india', 'indian', 'bharat', 'krishna', 'ganesh', 'ganesha', 'shiva',
  'ganpati', 'sairam', 'saibaba', 'jaishreeram', 'omnamahshivaya',
  'rahul', 'amit', 'rohit', 'vijay', 'ajay', 'suresh', 'ramesh', 'ravi',
  'kumar', 'sharma', 'singh', 'patel', 'reddy', 'naidu', 'rao',
  'sohan', 'mumbai', 'delhi', 'chennai', 'hyderabad', 'bangalore',
  'bengaluru', 'kolkata', 'punganur', 'andhra', 'telangana',
  'cricket', 'dhoni', 'sachin', 'virat', 'bollywood',
  // Business-context guesses an insider would try first
  'tamarind', 'seeds', 'pappu', 'husk', 'kata', 'weighbridge', 'lorry',
  'invoice', 'accounts', 'finance', 'office', 'company', 'factory',
  'mill', 'erp', 'erplogin', 'billing', 'ledger',
]);
