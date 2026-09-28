import { oauthProviderAuthServerMetadata } from '@better-auth/oauth-provider';
import { auth } from '@/server/auth';
export const GET=oauthProviderAuthServerMetadata(auth);
