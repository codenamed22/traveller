import NextAuth from "next-auth";
import Google from "next-auth/providers/google";

export function authConfigured() {
  return Boolean(process.env.AUTH_SECRET && process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET && process.env.ALLOWED_EMAILS);
}

export function allowedEmail(email: string | null | undefined) {
  return Boolean(email && process.env.ALLOWED_EMAILS?.split(",").map((entry) => entry.trim().toLowerCase()).includes(email.toLowerCase()));
}

// Editors create, edit and plan trips; anyone else who signs in can only view trips shared for viewing.
export const canEdit = allowedEmail;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [Google],
  session: { strategy: "jwt" },
  callbacks: {
    signIn({ user, profile }) {
      return profile?.email_verified === true && Boolean(user.email);
    },
  },
});