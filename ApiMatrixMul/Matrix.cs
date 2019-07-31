using System;
using System.Collections.Concurrent;
using System.Threading.Tasks;

namespace ApiMatrixMul
{
    public class Matrix
    {
        private ApiCalls _apiCalls;
        public int Size { get; private set; }
        public int[][] Items { get; private set; }

        public Matrix(int rows, ApiCalls apiCallObj)
        {
            _apiCalls = apiCallObj;

            Size = rows;

            AllocateMemory();
        }

        private void AllocateMemory()
        {
            Items = new int[Size][];

            for (int i = 0; i < Size; i++)
            {
                Items[i] = new int[Size];
            }
        }

        public void LoadData(string matrixName)
        {
            switch (matrixName)
            {
                case "A": break;

                case "B": break;

                default: return;
            }

            var exceptions = new ConcurrentQueue<Exception>();

            var rowsPerConn = Size / 10;           

            Parallel.For(0, 10, i =>
            {
                for (int row = i * rowsPerConn; row < (i + 1) * rowsPerConn; row++)
                {
                    try
                    {
                        var response = _apiCalls.GetRow(matrixName, row, i).Result;

                        if (response == null)
                        {
                            throw new Exception($"Could not retrieve row {row} for matrix {matrixName}");
                        }

                        if (!response.Success)
                        {
                            throw new Exception($"Could not retrieve row {row} for matrix {matrixName}. Reason: {response.Cause}");
                        }

                        if (response.Value.Length != Size)
                        {
                            throw new Exception($"Number of columns row {row} does not meet the expected count of {Size}");
                        }

                        Items[row] = response.Value;
                    }
                    catch (Exception e)
                    {
                        exceptions.Enqueue(e);
                    }
                }
            });

            if (exceptions.Count > 0)
            {
                throw new AggregateException(exceptions);
            }            
        }
    }
}
