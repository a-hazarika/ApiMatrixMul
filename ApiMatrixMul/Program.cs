using System;
using System.Diagnostics;
using System.Text;
using System.Threading.Tasks;
using ApiMatrixMul.Hashing;

namespace ApiMatrixMul
{
    class Program
    {
        static void Main(string[] args)
        {
            var size = 1000;

            var apiCalls = new ApiCalls(10);

            var sw = new Stopwatch();
            var totalTime = new Stopwatch();

            var matrixA = new Matrix(size, apiCalls);
            var matrixB = new Matrix(size, apiCalls);

            var result = new long[size][];

            for (int row = 0; row < size; row++)
            {
                result[row] = new long[size];
            }

            sw.Start();
            totalTime.Start();

            Console.WriteLine("Initializing matrix...");
            var initialized = apiCalls.InitializeMatrix(size);

            sw.Stop();
            Console.WriteLine($"Time taken to initialize matrix: {sw.Elapsed.TotalSeconds} seconds");

            if (initialized)
            {
                sw.Reset();
                sw.Start();
                Console.WriteLine("Loading matrix A");

                matrixA.LoadData("A");

                sw.Stop();
                Console.WriteLine($"Time taken to load matrix A: {sw.Elapsed.TotalSeconds} seconds");

                sw.Reset();
                sw.Start();
                Console.WriteLine("Loading matrix B");

                matrixB.LoadData("B");

                sw.Stop();
                Console.WriteLine($"Time taken to load matrix B: {sw.Elapsed.TotalSeconds} seconds");
            }

            sw.Reset();
            sw.Start();
            Console.WriteLine("Matrix multiplication A x B");

            Parallel.For(0, size, i =>
            {
                for (int j = 0; j < size; j++)
                {
                    for (int k = 0; k < size; k++)
                    {
                        result[i][j] += matrixA.Items[i][k] * matrixB.Items[k][j];
                    }
                }
            });

            sw.Stop();
            Console.WriteLine($"Time taken to multiply: {sw.Elapsed.TotalSeconds} seconds");

            sw.Reset();
            sw.Start();
            Console.WriteLine("Computing hash");

            var resultStr = new StringBuilder();

            for (int row = 0; row < size; row++)
            {
                for (int col = 0; col < size; col++)
                {
                    resultStr.Append(result[row][col]);
                }
            }

            var finalString = resultStr.ToString();

            var hash = Md5.GetHash(finalString);

            sw.Stop();
            Console.WriteLine($"Time taken to compute hash: {sw.Elapsed.TotalSeconds} seconds");

            var validationResult = apiCalls.ValidateResult(hash);
            totalTime.Stop();

            if (validationResult != null && validationResult.Success)
            {
                Console.WriteLine($"Server response: {validationResult.Value}");
            }

            Console.WriteLine($"Total time taken: {totalTime.Elapsed.TotalSeconds} seconds");
            Console.ReadLine();
        }
    }
}
