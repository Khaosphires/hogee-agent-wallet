import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Session } from "@hogee/core";
import type { ApiClientError } from "./client";
import { getSession, setPersona, type PersonaChange } from "./session";

export const sessionKey = ["getSession", null] as const;

export function useSession() {
  return useQuery<Session, ApiClientError>({ queryKey: sessionKey, queryFn: getSession });
}

export function useSetPersona() {
  const queryClient = useQueryClient();
  return useMutation<Session, ApiClientError, PersonaChange>({
    mutationFn: setPersona,
    onSuccess: async (session) => {
      queryClient.setQueryData(sessionKey, session);
      // Every other query is scoped by persona, so refetch them all.
      await queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] !== sessionKey[0] });
    },
  });
}
