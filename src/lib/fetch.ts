export const getFetchOptions = (
  data: any,
  headers: Record<string, string | null>,
  accessToken: string,
) => {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + accessToken,
      ...headers,
    },
    body: JSON.stringify({
      message: data,
    }),
  };
};
