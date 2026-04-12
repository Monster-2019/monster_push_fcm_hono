export const getFetchOptions = (data: any, accessToken: string) => {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + accessToken,
    },
    body: JSON.stringify({
      message: data,
    }),
  };
};
