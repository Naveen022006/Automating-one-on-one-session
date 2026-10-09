/**
 * Common passwords of 10+ characters (shorter ones are already rejected by the length rule). Compiled from the
 * most frequent entries of public breach corpora. Compared lowercased. Extend freely; a larger list can be loaded
 * from a file if needed.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  "1234567890", "0987654321", "12345678910", "123456789a", "a123456789", "1q2w3e4r5t", "1qaz2wsx3edc",
  "qwertyuiop", "qwerty1234", "qwerty12345", "qwerty123456", "asdfghjkl1", "zxcvbnm123", "1234qwerty",
  "password12", "password123", "password1234", "password12345", "password!1", "passw0rd123", "p@ssword123",
  "p@ssw0rd123", "password@123", "password#1", "passwordpassword", "mypassword", "mypassword1", "mypassword123",
  "iloveyou12", "iloveyou123", "iloveyou1234", "iloveyou2", "iloveyouforever", "princess123", "sunshine123",
  "football123", "baseball123", "basketball", "basketball1", "superman123", "batman1234", "starwars123",
  "welcome123", "welcome1234", "welcome@123", "letmein123", "letmein1234", "trustno1234", "changeme123",
  "administrator", "admin12345", "admin123456", "admin@1234", "administrator1", "rootpassword", "qwertyqwerty",
  "abcdefghij", "abcdefghijk", "abcdefg123", "abcd123456", "abc1234567", "abc123456789", "aaaaaaaaaa",
  "1111111111", "0000000000", "1212121212", "1122334455", "9876543210", "5555555555", "7777777777",
  "monkey1234", "dragon1234", "master1234", "shadow1234", "michael123", "jennifer123", "charlie123",
  "computer123", "internet123", "whatever123", "freedom123", "liverpool1", "chelsea123", "arsenal123",
  "manchester", "manchesterunited", "pokemon123", "minecraft1", "minecraft123", "fortnite123", "india12345",
  "india@123", "bharat1234", "krishna123", "ganesh1234", "mumbai1234", "delhi12345", "cricket123",
  "sachin1234", "qwerty@123", "test123456", "testing123", "test@12345", "demo123456",
  "secret1234", "secret12345", "summer2024", "summer2025", "summer2026", "winter2024", "winter2025",
  "winter2026", "spring2025", "autumn2025", "january2025", "password2024", "password2025", "password2026",
  "welcome2025", "welcome2026", "company123", "business123", "session123", "booking123", "influencer",
  "influencer1", "creator123", "youtube123", "instagram1", "instagram123", "facebook123", "google1234",
  "whatsapp123", "loveyou123", "lovelove12", "babygirl12", "hellohello", "helloworld", "helloworld1",
  "helloworld123", "goodluck123", "happy12345", "happiness1", "beautiful1", "blessed123", "jesus12345",
  "zaq12wsxcde", "1qazxsw23edc", "qazwsxedc123", "qazwsxedcrfv", "asdf123456", "asdfasdfasdf", "zxcvbnm1234",
]);
