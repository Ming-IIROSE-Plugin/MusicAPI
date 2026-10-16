export class SendRequest {
  public static async sendGet(
    url: string,
    params: URLSearchParams,
    headers: HeadersInit,
    signal?: AbortSignal,
  ) {
    const fullUrl = `${url}?${params.toString()}`;
    const response = await fetch(fullUrl, {
      method: "GET",
      credentials: "include",
      headers: headers,
      signal: signal,
    });

    return response;
  }

  public static async sendPost(
    url: string,
    params: URLSearchParams,
    headers: HeadersInit,
    signal?: AbortSignal,
  ) {
    const response = await fetch(url, {
      method: "POST",
      credentials: "include",
      body: params,
      headers: headers,
      signal: signal,
    });

    return response;
  }

  public postWithUrlFormData(
    url: string,
    params: FormData,
    headers: Headers,
    progressDiv: HTMLDivElement | null,
  ): Promise<XMLHttpRequest["response"] | null> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url, true);
      xhr.withCredentials = true;

      // Set request headers
      headers.forEach((value, key) => {
        xhr.setRequestHeader(key, value);
      });

      xhr.upload.onprogress = function (event) {
        if (event.lengthComputable) {
          const percentComplete = (event.loaded / event.total) * 100;
          if (progressDiv) {
            if (percentComplete > 8) {
              progressDiv.style.width = percentComplete.toFixed(0) + "%";
            }
            progressDiv.innerHTML = percentComplete.toFixed(0) + "%";
            if (percentComplete.toFixed(0) === "100") {
              progressDiv.innerHTML = "Done";

              setTimeout(() => {
                // progressDiv.style.opacity = '0';
                progressDiv.addEventListener(
                  "transitionend",
                  (e) => {
                    if (e.propertyName === "opacity") {
                      // progressDiv.style.width = '0';
                    }
                  },
                  { once: true },
                );
              }, 1000);
            }
          }
        }
      };

      xhr.onload = function () {
        if (xhr.status === 200) {
          resolve(JSON.parse(xhr.response));
        } else {
          reject(new Error("Network response was not ok"));
        }
      };

      xhr.onerror = function () {
        reject(new Error("Backend Not Running"));
      };

      xhr.send(params);
    });
  }
}
