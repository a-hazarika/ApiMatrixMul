using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;

namespace ApiMatrixMul.Hashing
{
    public static class Md5
    {
        public static string GetHash(string inputString)
        {
            using (MD5 md5Hash = MD5.Create())
            {
                var hash = GetMd5Hash(md5Hash, inputString);

                return hash;
            }
        }

        private static string GetMd5Hash(MD5 md5Hash, string input)
        {
            byte[] data = md5Hash.ComputeHash(Encoding.UTF8.GetBytes(input));

            var builder = new StringBuilder();

            for (int i = 0; i < data.Length; i++)
            {
                builder.Append(data[i].ToString("x2"));
            }

            return builder.ToString();
        }
    }
}
