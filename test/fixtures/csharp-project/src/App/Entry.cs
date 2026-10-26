using Synthetic.Library;

namespace Synthetic.App
{
    public class Application : BaseProcessor, IProcessor
    {
        public int Name { get; set; }

        public int Process(int value)
        {
            return Format(value);
        }

        public int Run(int input)
        {
            return ExplicitFeature.Execute(Process(input));
        }
    }
}
