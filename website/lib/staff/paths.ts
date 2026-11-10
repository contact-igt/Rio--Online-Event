// Fixed paths for the staff area. Built here, never from request input, so there is no open redirect.
export type StaffRole = "admin" | "judge";

export const staffLoginPath = "/staff/login";
export const staffPasswordPath = "/staff/set-password";
export const staffHome = (role: StaffRole): string => (role === "admin" ? "/admin" : "/judge");
