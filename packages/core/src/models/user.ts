export interface UserPreferences {
  preferredGroups?: string[];
  lastChannelId?: string;
  locale?: string;
}

export interface UserProfile {
  id: string;
  email: string;
  preferences: UserPreferences;
}
