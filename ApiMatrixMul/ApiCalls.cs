using System;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using ApiResponseModels;
using Newtonsoft.Json;

namespace ApiMatrixMul
{
    public class ApiCalls
    {        
        private const string ApiBase = @"https://recruitment-test.investcloud.com/api/numbers";

        private readonly string _matrixInitUrl;
        private readonly string _validationUrl;        

        private int _maxHttpConnections;
        private HttpClient[] _httpClient;

        public ApiCalls(int maxHttpConnections)
        {
            _matrixInitUrl = $"{ApiBase}/init";
            _validationUrl = $"{ApiBase}/validate";
            _maxHttpConnections = maxHttpConnections;
            _httpClient = new HttpClient[_maxHttpConnections];

            InitializeHttpConnections();
        }

        public bool InitializeMatrix(int size)
        {
            var resultContent = string.Empty;

            using (var requestMessage =
            new HttpRequestMessage(HttpMethod.Get, $"{_matrixInitUrl}/{size}"))
            {
                var result = _httpClient[0].SendAsync(requestMessage).Result;
                resultContent = result.Content.ReadAsStringAsync().Result;

                try
                {
                    if (result.IsSuccessStatusCode)
                    {
                        var responseObj = JsonConvert.DeserializeObject<InitResponse>(resultContent);

                        return responseObj.Success;
                    }

                    return false;
                }
                catch (Exception ex)
                {
                    //Log exception
                    return false;
                }
            }
        }

        private void InitializeHttpConnections()
        {
            Parallel.For(0, _maxHttpConnections, i => {
                _httpClient[i] = new HttpClient();
            });
        }

        public async Task<RowColDataResponse> GetRow(string matrixName, int rowNumber, int httpClientIdx)
        {
            var resultContent = string.Empty;

            using (var requestMessage =
            new HttpRequestMessage(HttpMethod.Get, $"{ApiBase}/{matrixName}/row/{rowNumber}"))
            {
                var result = await _httpClient[httpClientIdx].SendAsync(requestMessage);
                resultContent = await result.Content.ReadAsStringAsync();

                try
                {
                    if (result.IsSuccessStatusCode)
                    {
                        var responseObj = JsonConvert.DeserializeObject<RowColDataResponse>(resultContent);

                        return responseObj;
                    }

                    return null;
                }
                catch (Exception ex)
                {
                    //Log exception
                    return null;
                }
            }
        }

        public ValidationResponse ValidateResult(string resultHash)
        {
            using (var requestMessage =
            new HttpRequestMessage(HttpMethod.Post, _validationUrl))
            {
                if (!string.IsNullOrWhiteSpace(resultHash))
                {
                    requestMessage.Content = new StringContent(resultHash, Encoding.UTF8, "application/json");
                }

                var serverResult = _httpClient[0].SendAsync(requestMessage).Result;
                var resultContent = serverResult.Content.ReadAsStringAsync().Result;

                try
                {
                    if (serverResult.IsSuccessStatusCode)
                    {
                        var responseObj = JsonConvert.DeserializeObject<ValidationResponse>(resultContent);

                        return responseObj;
                    }

                    return null;
                }
                catch (Exception ex)
                {
                    //Log exception
                    return null;
                }
            }
        }
    }
}
